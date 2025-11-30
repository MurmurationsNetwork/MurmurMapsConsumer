import { MessageBatch } from "@cloudflare/workers-types";
import { D1Database } from "@cloudflare/workers-types";
import { updateJobOnFailure, updateTotalNodes, updateProcessedNodes, updateJobStatus, updateJobResultSummary, getJobByUuid } from "./models/job";
import { getDB } from "./db";
import { getCluster, updateClusterTimestamp } from "../src/models/cluster";
import { fetchProfiles, processProfile, checkProfileAuthority } from "./utils/profile";
import { createNode, getNodes, softDeleteNode, updateNode, getUnavailableNodes, getNodesByLastUpdateJobUuid, getNodesByIds, updateNodeStatus } from "./models/node";
import type { NodeInsert, NodeDbUpdateInput } from "./types/node";
import { DrizzleD1Database } from "drizzle-orm/d1";

export interface Env {
    DB: D1Database;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processCreateNodes(db: DrizzleD1Database, clusterUuid: string, jobUuid: string) {
    console.log(`🔄 Processing create-nodes for cluster: ${clusterUuid}, job: ${jobUuid}`);

    const cluster = await getCluster(db, clusterUuid);
    if (!cluster) {
        console.error(`❌ Cluster not found: ${clusterUuid}`);
        updateJobOnFailure(db, jobUuid, `Cluster not found: ${clusterUuid}`);
        return;
    }

    const rawNodes = await fetchProfiles(cluster.indexUrl, cluster.queryUrl);
    const totalNodes = rawNodes.length;
    await updateTotalNodes(db, jobUuid, totalNodes);

    for (let i = 0; i < rawNodes.length; i++) {
        const { profile_data, status, is_available, unavailable_message } = await processProfile(
            rawNodes[i],
            cluster.indexUrl
        );

        const nodeData: NodeInsert = {
            clusterUuid: cluster.clusterUuid,
            profileUrl: rawNodes[i].profileUrl as string,
            data: JSON.stringify(profile_data ?? {}),
            status: status,
            lastUpdated: rawNodes[i].lastUpdated,
            isAvailable: is_available ? 1 : 0,
            unavailableMessage: unavailable_message,
            hasAuthority: 1
        };

        await createNode(db, nodeData);
        await updateProcessedNodes(db, jobUuid);
    }

    await updateJobStatus(db, jobUuid, 'completed');

    console.log(`✅ Completed create-nodes for cluster: ${clusterUuid}`);
}

/**
 * Retrieve data from the index service with timestamp, which means get updated profiles only.
 * There are 5 types of profiles:
 * 1. new profiles - profiles that are not in the nodes table
 * 2. updated profiles - profiles that are in the nodes table and have updates
 * 3. unavailable profiles - profiles that unavailable in nodes table needs to check again to see if it's available now
 * 4. deleted profiles - profiles status is marked as "deleted" in the index service
 * 5. unauthoritative profiles - if a profile's domain authority is false, and there are no other available profiles, it will be marked as unauthorized. Otherwise, unauthoritative profiles should be showed in the profiles list.
 */
async function processUpdateNodes(db: DrizzleD1Database, clusterUuid: string, jobUuid: string) {
    console.log(`🔄 Processing update-nodes for cluster: ${clusterUuid}, job: ${jobUuid}`);

    try {
        await updateJobStatus(db, jobUuid, 'processing');

        const cluster = await getCluster(db, clusterUuid);
        if (!cluster) {
            await updateJobOnFailure(db, jobUuid, `Cluster not found: ${clusterUuid}`);
            return;
        }

        const existingNodes = await getNodes(db, clusterUuid);
        // Remove posted status from query url
        const queryBase = cluster.queryUrl?.replace(/([&?])status=posted(&)?/, '$1') ?? '';
        const since = cluster?.lastUpdated ? `&last_updated=${cluster.lastUpdated}` : '';
        const queryUrl = `${queryBase}${since}`;

        const rawNodes = await fetchProfiles(cluster.indexUrl, queryUrl);

        // 1) Calculate the total number of nodes to process
        const newNodesCount = rawNodes.length;
        const unavailableNodesCount = existingNodes.filter(node => node.isAvailable === 0).length;
        const authoritativeNodesCount = existingNodes.length + newNodesCount;
        const totalProcessedNodes = newNodesCount + authoritativeNodesCount + unavailableNodesCount;
        await updateTotalNodes(db, jobUuid, totalProcessedNodes);

        let cntCreated = 0;
        let cntUpdated = 0;
        let cntDeleted = 0;
        let cntUnavailableChecked = 0;
        let cntAuthorityChanged = 0;
        let batchIncrement = 0;

        // 2. Process New Profiles
        for (let i = 0; i < rawNodes.length; i++) {
            const profile = rawNodes[i];

            const existingNode = existingNodes.find(node => node.profileUrl === profile.profileUrl);
            if (profile.status === "deleted") {
                if (existingNode) {
                    await softDeleteNode(db, clusterUuid, profile.profileUrl, jobUuid);
                    cntDeleted++;
                }
                batchIncrement++;
            } else if (existingNode?.status === "ignored") {
                batchIncrement++;
            } else {
                const existingTs = existingNode ? new Date(existingNode.lastUpdated).getTime() : 0;
                const profileTs = new Date(profile.lastUpdated * 1000).getTime();
                const shouldCreate = !existingNode;
                const shouldUpdate = !!existingNode && profileTs !== existingTs;

                if (shouldCreate || shouldUpdate) {
                    const { profile_data, status, is_available, unavailable_message } = await processProfile(profile, cluster.indexUrl);

                    if (shouldCreate) {
                        await createNode(db, {
                            clusterUuid,
                            profileUrl: profile.profileUrl,
                            data: JSON.stringify(profile_data),
                            status,
                            lastUpdated: profile.lastUpdated,
                            isAvailable: is_available ? 1 : 0,
                            unavailableMessage: unavailable_message,
                            hasAuthority: 1,
                            isDeleted: 0,
                            lastUpdateJobUuid: jobUuid
                        });
                        cntCreated++;
                    } else {
                        await updateNode(db, clusterUuid, existingNode.id, {
                            data: existingNode.data,
                            updatedData: JSON.stringify(profile_data),
                            lastUpdated: profile.lastUpdated,
                            status: existingNode.status,
                            isAvailable: is_available ? 1 : 0,
                            unavailableMessage: unavailable_message,
                            hasUpdated: 1,
                            lastUpdateJobUuid: jobUuid
                        });
                        cntUpdated++;
                    }
                }
                batchIncrement++;
            }

            if (batchIncrement >= 10 || i === rawNodes.length - 1) {
                await updateProcessedNodes(db, jobUuid, batchIncrement);
                batchIncrement = 0;
            }

            // Prevent shutdown by D1 and worker
            if ((i % 10) === 0) await sleep(30);
        }

        // 3. Process Unavailable Profiles
        const unavailableProfiles = await getUnavailableNodes(db, clusterUuid);
        for (let i = 0; i < unavailableProfiles.length; i++) {
            const unavailableNode = unavailableProfiles[i];
            const { profile_data, is_available, unavailable_message } = await processProfile(unavailableNode, cluster.indexUrl);

            await updateNode(db, clusterUuid, unavailableNode.id, {
                data: JSON.stringify(profile_data),
                isAvailable: is_available ? 1 : 0,
                unavailableMessage: unavailable_message,
                lastUnavailableCheckJobUuid: jobUuid
            });
            cntUnavailableChecked++;

            batchIncrement++;
            if (batchIncrement >= 5 || i === unavailableProfiles.length - 1) {
                await updateProcessedNodes(db, jobUuid, batchIncrement);
                batchIncrement = 0;
            }

            // Prevent shutdown by D1 and worker
            if ((i % 10) === 0) await sleep(30);
        }

        // 4. Handle unauthoritative profiles
        // Previously, we retrieve updated profiles and unavailable profiles.
        // Now, we need to check if the profiles have authority or not.
        // 1. The first step involves checking the authority status of each profile. If the authority status remains unchanged, it indicates there are no modifications required, and thus, no action will be taken.
        // 2. If the authority status changes, there are two distinct scenarios:
        // 2.1 AP to UAP: If it's in a 'publish' status, we need to move it to the unauthorized list. Updated profiles and unavailable profiles only have AP to UAP states, because default value of has_authority is TRUE. If updated profiles and unavailable profiles transition to UAP, we don't want to move them to the unauthorized list.
        // - 2.2 If a profile shifts from UAP to AP, we update the profile's background to reflect its new AP status. If users want to add this profile, they can go to 'Edit Nodes' and modify the status there.

        const authorityMap = await getAuthorityMap(db, clusterUuid);

        // 4a) Check authority status of each existing profile
        for (let i = 0; i < existingNodes.length; i++) {
            const profile = existingNodes[i];

            // latestData：prioritize updatedData
            const latest = JSON.parse(profile.updatedData ?? profile.data);
            const newAuth = checkProfileAuthority(authorityMap ?? [], latest.primary_url, profile.profileUrl) ? 1 : 0;

            if (newAuth !== (profile.hasAuthority ? 1 : 0)) {
                // AP -> UAP processing
                const patch: NodeDbUpdateInput = {
                    data: profile.data,
                    hasAuthority: newAuth,
                    lastAuthorityChangeJobUuid: jobUuid
                };

                if (profile.hasAuthority === 1 && newAuth === 0) {
                    // Mark as ignored, and merge updatedData into data, clear updatedData
                    patch.status = 'ignore';
                    patch.data = JSON.stringify(latest);
                    patch.updatedData = null;
                    patch.hasUpdated = 0;
                }
                await updateNode(db, clusterUuid, profile.id, patch);
                cntAuthorityChanged++;
            }

            batchIncrement++;
            if (batchIncrement >= 10 || i === existingNodes.length - 1) {
                await updateProcessedNodes(db, jobUuid, batchIncrement);
                batchIncrement = 0;
            }

            // Prevent shutdown by D1 and worker
            if ((i % 10) === 0) await sleep(30);
        }

        // 4b) Check authority status of profiles updated in this job
        const updatedThisJob = await getNodesByLastUpdateJobUuid(db, clusterUuid, jobUuid);
        for (let i = 0; i < updatedThisJob.length; i++) {
            const profile = updatedThisJob[i];
            const latest = JSON.parse(profile.updatedData ?? profile.data);
            const newAuth = checkProfileAuthority(authorityMap ?? [], latest.primary_url, profile.profileUrl) ? 1 : 0;

            if (newAuth !== (profile.hasAuthority ? 1 : 0)) {
                const patch: NodeDbUpdateInput = {
                    data: profile.data,
                    hasAuthority: newAuth,
                    lastAuthorityChangeJobUuid: jobUuid
                };
                if (profile.hasAuthority === 1 && newAuth === 0) {
                    patch.status = 'ignore';
                    patch.data = JSON.stringify(latest);
                    patch.updatedData = null;
                    patch.hasUpdated = 0;
                }
                await updateNode(db, clusterUuid, profile.id, patch);
                cntAuthorityChanged++;
            }

            batchIncrement++;
            if (batchIncrement >= 10 || i === updatedThisJob.length - 1) {
                await updateProcessedNodes(db, jobUuid, batchIncrement);
                batchIncrement = 0;
            }

            // Prevent shutdown by D1 and worker
            if ((i % 10) === 0) await sleep(30);
        }

        await updateClusterTimestamp(db, clusterUuid, Math.floor(Date.now() / 1000));
        await updateJobResultSummary(db, jobUuid, {
            counts: {
                created: cntCreated,
                updated: cntUpdated,
                deleted: cntDeleted,
                unavailableChecked: cntUnavailableChecked,
                authorityChanged: cntAuthorityChanged
            }
        });

        console.log(`✅ Completed update-nodes for cluster: ${clusterUuid}`);
    } catch (error) {
        console.error(`❌ Error updating job status for update-nodes: ${jobUuid}:`, error);
        await updateJobOnFailure(db, jobUuid, error instanceof Error ? error.message : 'Unknown error');
    }
}

async function processUpdateNodeStatuses(db: DrizzleD1Database, clusterUuid: string, jobUuid: string) {
    console.log(`🔄 Processing update-node-statuses for cluster: ${clusterUuid}, job: ${jobUuid}`);

    try {
        await updateJobStatus(db, jobUuid, 'processing');

        const job = await getJobByUuid(db, jobUuid);
        if (!job) {
            throw new Error('Job not found');
        }
        const { node_ids, status } = JSON.parse(job.payload ?? '{}');

        if (!node_ids || node_ids.length === 0) {
            throw new Error('node_ids must be a non-empty array');
        }

        const existingNodes = await getNodesByIds(db, clusterUuid, node_ids);

        if (!existingNodes.length) throw new Error('No nodes found');

        await updateTotalNodes(db, jobUuid, existingNodes.length);

        let processed = 0;

        for (let i = 0; i < existingNodes.length; i++) {
            const node = existingNodes[i];
            await updateNodeStatus(db, clusterUuid, node.id, status, node.updatedData ?? null, node.hasUpdated ? true : false);
            processed++;

            if (processed % 10 === 0 || i === existingNodes.length - 1) {
                await updateProcessedNodes(db, jobUuid, processed);
                processed = 0;
            }

            // Prevent shutdown by D1 and worker
            await sleep(30);
        }

        await updateJobStatus(db, jobUuid, 'completed');

        console.log(`✅ Completed update-node-statuses for cluster: ${clusterUuid}`);
    } catch (error) {
        console.error(`❌ Error updating job status for update-node-statuses: ${jobUuid}:`, error);
        await updateJobOnFailure(db, jobUuid, error instanceof Error ? error.message : 'Unknown error');
    }

    console.log(`✅ Completed update-node-statuses for cluster: ${clusterUuid}`);
}

async function getAuthorityMap(db: DrizzleD1Database, clusterUuid: string) {
    const nodes = await getNodes(db, clusterUuid);
    const authorityHosts = new Set<string>();

    for (const node of nodes) {
        try {
            const data = JSON.parse(node.data);
            const primaryUrl = data.primary_url;

            if (!primaryUrl) continue;

            const profileHost = new URL(node.profileUrl).hostname;
            const primaryHost = new URL(primaryUrl).hostname;

            if (profileHost === primaryHost) {
                authorityHosts.add(primaryHost);
            }
        } catch (urlError) {
            // Skip invalid URLs
            console.warn(`Invalid URL in node ${node.id}:`, urlError);
            continue;
        }
    }

    return Array.from(authorityHosts);
}

export default {
    async queue(batch: MessageBatch<any>, env: Env) {
        console.log("📬 Received:", batch);

        const db = getDB(env);

        await Promise.all(
            batch.messages.map(async (message) => {
                const { job_uuid, type, target_id, target_type } = message.body;

                if (target_type === 'clusters' && type === 'create-nodes') {
                    try {
                        await processCreateNodes(db, target_id, job_uuid);
                    } catch (error) {
                        console.error(`❌ Error processing create-nodes for cluster ${target_id}:`, error);
                        await updateJobOnFailure(db, job_uuid, error instanceof Error ? error.message : 'Unknown error');
                    }
                } else if (type === 'update-nodes' && target_type === 'clusters') {
                    try {
                        await processUpdateNodes(db, target_id, job_uuid);
                    } catch (error) {
                        console.error(`❌ Error processing update-nodes for cluster ${target_id}:`, error);
                        await updateJobOnFailure(db, job_uuid, error instanceof Error ? error.message : 'Unknown error');
                    }
                } else if (target_type === 'clusters' && type === 'update-node-statuses') {
                    try {
                        await processUpdateNodeStatuses(db, target_id, job_uuid);
                    } catch (error) {
                        console.error(`❌ Error processing update-node-statuses for cluster ${target_id}:`, error);
                        await updateJobOnFailure(db, job_uuid, error instanceof Error ? error.message : 'Unknown error');
                    }
                } else {
                    console.log("❌ Unhandled message type:", {
                        job_uuid,
                        type,
                        target_id,
                        target_type
                    });
                    console.log("Full message body:", message.body);
                    await updateJobOnFailure(db, job_uuid, 'Unhandled message type');
                }
                message.ack();
            })
        );
    },

    async fetch(request: Request, env: Env) {
        const msg = await request.json();
        console.log("🟢 Message:", msg);

        const fakeBatch: MessageBatch<any> = {
            messages: [
                {
                    id: crypto.randomUUID(),
                    body: msg,
                    ack: () => console.log("🟢 Message acknowledged"),
                    retry: () => console.log("🟢 Message retried"),
                    attempts: 0
                }
            ]
        } as any;

        await this.queue(fakeBatch, env);

        return new Response("Simulated queue processed!");
    }
};
