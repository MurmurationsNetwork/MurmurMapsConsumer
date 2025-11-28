import { jobs } from '../db/schema';
import type { JobCreateInput, JobResultSummary } from '../types/job';
import { eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export async function getJobByUuid(db: DrizzleD1Database, jobUuid: string) {
	return await db.select().from(jobs).where(eq(jobs.jobUuid, jobUuid)).get();
}

export async function createJob(db: DrizzleD1Database, job: JobCreateInput) {
	return await db.insert(jobs).values(job).returning().run();
}

export async function updateJobOnFailure(
	db: DrizzleD1Database,
	jobUuid: string,
	errorMessage: string
) {
	const now = Math.floor(Date.now() / 1000);

	return await db
		.update(jobs)
		.set({
			status: 'failed',
			errorMessage: errorMessage,
			finishedAt: now,
			updatedAt: now
		})
		.where(eq(jobs.jobUuid, jobUuid))
		.run();
}

export async function updateTotalNodes(db: DrizzleD1Database, jobUuid: string, totalNodes: number) {
	return await db
		.update(jobs)
		.set({ totalNodes })
		.where(eq(jobs.jobUuid, jobUuid))
		.run();
}

export async function updateProcessedNodes(db: DrizzleD1Database, jobUuid: string, increment: number = 1) {
	if (increment <= 0) return;

	return await db
		.update(jobs)
		.set({
			processedNodes: sql`CASE 
				WHEN ${jobs.processedNodes} + ${increment} < ${jobs.totalNodes} 
				THEN ${jobs.processedNodes} + ${increment} 
				ELSE ${jobs.totalNodes}
			END`
		})
		.where(eq(jobs.jobUuid, jobUuid));
}

export async function updateJobStatus(db: DrizzleD1Database, jobUuid: string, status: string) {
	return await db
		.update(jobs)
		.set({ status, finishedAt: Math.floor(Date.now() / 1000) })
		.where(eq(jobs.jobUuid, jobUuid))
		.run();
}

export async function updateJobResultSummary(db: DrizzleD1Database, jobUuid: string, summary: JobResultSummary) {
	return await db
		.update(jobs)
		.set({ result: JSON.stringify(summary), errorMessage: null, status: 'completed' })
		.where(eq(jobs.jobUuid, jobUuid))
		.run();
}