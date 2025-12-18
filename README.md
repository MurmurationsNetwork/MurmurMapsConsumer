# MurmurMaps Consumer

## Overview

This project functions as a Consumer within the MurmurMaps architecture. Its primary responsibility is to asynchronously handle long-running background tasks—such as cluster creation, node updates, and bulk node status updates—by consuming messages from Cloudflare Queues.

This consumer solves several critical problems:

- Cloudflare Pages / Workers execution limits: long‑running operations are no longer constrained by request‑response timeouts.

- Unreliable or slow client connections: tasks continue running even if the client disconnects or has poor network conditions.

- Improved user experience: the client only needs to display background job progress, rather than blocking on synchronous operations.

In practice, the client triggers a job (such as creating clusters or updating nodes), enqueues a message, and then periodically polls job status. The actual work is performed entirely by this MurmurMaps Consumer, ensuring reliability, scalability, and fault tolerance.

Main Project repository: [MurmurMaps](https://github.com/MurmurationsNetwork/MurmurMaps).

## Local Develepment Guide

### Prerequisites

- Node.js (20+)
- pnpm

⚠️ Important:
MurmurMaps and MurmurMapsConsumer must be located under the same parent directory.

```bash
projects/
├── MurmurMaps/
└── MurmurMapsConsumer/
```

### 1. Link the Local D1 Database

The Consumer reuses MurmurMaps’ local D1 database by linking the `.wrangler` directory.

Run the following command in MurmurMaps Consumer:

```bash
pnpm run db:link
```

This executes:

```bash
ln -s ../MurmurMaps/.wrangler .wrangler
```

This ensures both projects share the same local D1 database during development.

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Run the Consumer Locally

```bash
pnpm dev
```

By default, the Worker will be available at:

```bash
http://localhost:8787
```

### 4. Trigger a Job Locally

For local testing, jobs can be triggered by sending a request to the Consumer.

#### Request

```bash
GET http://localhost:8787
```

#### Body

```bash
{
  "job_uuid": "35eb82cf-4955-42b2-8bc9-cb743a73976d",
  "type": "create-nodes",
  "target_id": "1ea18216-aae8-4a47-a0b1-3aba0a9e7820",
  "target_type": "clusters"
}
```

The payload corresponds to a row in the `jobs` table and simulates a queue message being processed by the Consumer.

## Cloudflare Deployment Guide

### Prerequisite

Please complete the [MurmurMaps](https://github.com/MurmurationsNetwork/MurmurMaps) project setup and deployment before configuring and deploying the MurmurMaps Consumer (this project).

### 1. Configure `wrangler.jsonc` in MurmurMaps Consumer (this project)

⚠️ Important:
Please use the same queue names as those defined for the queue producers in the MurmurMaps project.

```jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "murmur-maps-queue"
      }
    ]
  }
}
```

### 2. Deploy MurmurMaps Consumer (this project) as Cloudflare Worker

Click "Create application" on the Cloudflare "Workers & Pages" page, and the queue will be automatically bound to this Worker.

### 3. Validate the Cloudflare Queue status

Once the consumer (this project) and producer (MurmurMaps) are deployed, the queue status will become **Active** in the Cloudflare dashboard.
