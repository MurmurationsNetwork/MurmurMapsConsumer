# MurmurMaps Consumer

## Overview

This project functions as a Consumer within the MurmurMaps architecture. Its primary responsibility is to asynchronously handle long-running background tasks—such as cluster creation, node updates, and bulk node status updates—by consuming messages from Cloudflare Queues.

This consumer solves several critical problems:

- Cloudflare Pages / Workers execution limits: long‑running operations are no longer constrained by request‑response timeouts.

- Unreliable or slow client connections: tasks continue running even if the client disconnects or has poor network conditions.

- Improved user experience: the client only needs to display background job progress, rather than blocking on synchronous operations.

In practice, the client triggers a job (such as creating clusters or updating nodes), enqueues a message, and then periodically polls job status. The actual work is performed entirely by this MurmurMaps Consumer, ensuring reliability, scalability, and fault tolerance.

Main Project repository: [MurmurMaps](https://github.com/MurmurationsNetwork/MurmurMaps).

## Setup Guide

### Prerequisites

Before starting, make sure you have:

- A Cloudflare account with Workers, Queues, and D1 enabled
- Access to the MurmurMaps repository

### 1. Create a Cloudflare Queue

First, create a queue in the Cloudflare dashboard. This queue will be used to deliver background jobs from the producer (MurmurMaps Pages) to the consumer (this Worker).

Example queue name:

- murmur-maps-queue

Once created, the queue will initially appear as `inactive` until both a consumer and a producer are correctly configured.

### 2. Configure `wrangler.jsonc` in MurmurMaps Consumer (this project)

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

### 3. Deploy MurmurMaps Consumer (this project) as Cloudflare Worker

Click "Create application" on the Cloudflare "Workers & Pages" page, and the queue will be automatically bound to this Worker.

### 4. Configure `wrangler.jsonc` in MurmurMaps and redeploy the application for the changes to take effect

```jsonc
{
  "queues": {
    "producers": [
      {
        "queue": "murmur-maps-queue",
        "binding": "JOB_QUEUE"
      }
    ]
  }
}
```

### 5. Validate the Cloudflare Queue status

Once the consumer and producer are deployed, the queue status will become **Active** in the Cloudflare dashboard.
