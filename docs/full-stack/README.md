# FastAPI + PostgreSQL + Redis + RabbitMQ (Full Stack)

**Overview:** Complete asynchronous architecture with message queue for background processing, event-driven workflows, and decoupled services.

## Stack Components

- **FastAPI:** Async ASGI application framework
- **PostgreSQL:** Relational database (primary + read replicas)
- **Redis:** In-memory cache and session store
- **RabbitMQ:** Message broker for async processing
- **PgBouncer:** Connection pooler

## Architecture

```
                         Client Request
                               │
                    ┌──────────▼──────────┐
                    │   FastAPI (Async)   │
                    └──┬────────┬────────┬─┘
                       │        │        │
        ┌──────────────┘        │        └──────────────┐
        │                       │                       │
   ┌────▼─────┐          ┌─────▼──────┐         ┌─────▼──────┐
   │  Redis   │          │PostgreSQL  │         │ RabbitMQ   │
   │ (Cache)  │          │   (Data)   │         │  (Queue)   │
   └──────────┘          └────────────┘         └─────┬──────┘
                                                       │
                                               ┌───────▼────────┐
                                               │ Worker Process │
                                               │ (Celery/aio)  │
                                               └───────┬────────┘
                                                       │
                                               ┌───────▼────────┐
                                               │  PostgreSQL    │
                                               │  (Write back)  │
                                               └────────────────┘
```

---

## When to Add RabbitMQ

**✅ Add RabbitMQ when you need:**

1. **Async Processing:**
   - Email sending (don't block API response)
   - Image/video processing
   - Report generation
   - Data exports

2. **Decoupling Services:**
   - Microservices communication
   - Event-driven architecture
   - Service-to-service messaging

3. **Rate Limiting / Buffering:**
   - Handle traffic spikes by queuing
   - Process at sustainable rate
   - Prevent database overload

4. **Reliability:**
   - Guaranteed message delivery
   - Retry failed operations
   - Dead letter queues for errors

**❌ Don't add RabbitMQ if:**
- All operations are synchronous (user waits)
- Simple request/response pattern sufficient
- No background processing needed
- Adds unnecessary complexity

---

## Example Use Cases

### 1. Email Sending (Async)

**Without RabbitMQ:**
```python
@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    # Create user in DB
    user_id = await db.create_user(user)

    # Send welcome email (BLOCKS for 2-5 seconds!)
    await email_service.send_welcome(user.email)

    return {"id": user_id}
```

**Response time:** 2-5 seconds (user waits for email)

**With RabbitMQ:**
```python
@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    # Create user in DB
    user_id = await db.create_user(user)

    # Publish message to queue (< 5ms)
    await rabbitmq.publish('email_queue', {
        'type': 'welcome_email',
        'user_id': user_id,
        'email': user.email
    })

    return {"id": user_id}  # Returns immediately!

# Worker processes email queue
async def email_worker():
    async for message in rabbitmq.consume('email_queue'):
        await email_service.send_welcome(message['email'])
        message.ack()  # Mark as processed
```

**Response time:** 50ms (user doesn't wait for email)

### 2. Image Processing

```python
@app.post("/api/v1/upload")
async def upload_image(file: UploadFile):
    # Save original
    file_id = await storage.save(file)

    # Queue thumbnail generation (don't wait)
    await rabbitmq.publish('image_processing', {
        'file_id': file_id,
        'tasks': ['thumbnail', 'optimize', 'watermark']
    })

    return {"file_id": file_id, "status": "processing"}

# Worker generates thumbnails
async def image_worker():
    async for message in rabbitmq.consume('image_processing'):
        file_id = message['file_id']

        # Process in background
        await generate_thumbnail(file_id)
        await optimize_image(file_id)
        await add_watermark(file_id)

        # Update status in DB
        await db.update_file_status(file_id, 'completed')

        message.ack()
```

### 3. Event-Driven Architecture

```python
# Service A: User created event
@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    user_id = await db.create_user(user)

    # Publish event (multiple services can subscribe)
    await rabbitmq.publish_event('user.created', {
        'user_id': user_id,
        'email': user.email,
        'timestamp': datetime.now()
    })

    return {"id": user_id}

# Service B: Analytics consumer
async def analytics_consumer():
    async for event in rabbitmq.consume('analytics_queue'):
        if event['type'] == 'user.created':
            await analytics.track_new_user(event['user_id'])
        event.ack()

# Service C: Email consumer
async def email_consumer():
    async for event in rabbitmq.consume('email_queue'):
        if event['type'] == 'user.created':
            await send_welcome_email(event['email'])
        event.ack()

# Service D: CRM consumer
async def crm_consumer():
    async for event in rabbitmq.consume('crm_queue'):
        if event['type'] == 'user.created':
            await crm.create_contact(event)
        event.ack()
```

---

## RabbitMQ Configuration

### For 10k RPS (30% queue usage = 3k messages/sec)

```yaml
Cluster: 3 nodes
Instance Type: c6i.xlarge (4 vCPU, 8 GB RAM) per node
Cost: 3 × $80 = $240/month

Configuration:
  cluster_formation.peer_discovery_backend: rabbit_peer_discovery_classic_config
  cluster_formation.classic_config.nodes: rabbit@node1,rabbit@node2,rabbit@node3

  # Performance
  vm_memory_high_watermark: 0.6
  disk_free_limit: 50GB

  # Queues
  queue_master_locator: min-masters  # Distribute queues evenly

  # Federation (for multi-region)
  federation.upstream_sets: ...
```

---

## FastAPI Integration

### Setup with aio-pika

```python
import aio_pika
from fastapi import FastAPI

app = FastAPI()
rabbitmq_connection = None
rabbitmq_channel = None

@app.on_event("startup")
async def startup():
    global rabbitmq_connection, rabbitmq_channel

    # Connect to RabbitMQ
    rabbitmq_connection = await aio_pika.connect_robust(
        "amqp://user:pass@rabbitmq:5672/",
        heartbeat=60,
    )

    # Create channel
    rabbitmq_channel = await rabbitmq_connection.channel()
    await rabbitmq_channel.set_qos(prefetch_count=10)

    # Declare queues
    await rabbitmq_channel.declare_queue('email_queue', durable=True)
    await rabbitmq_channel.declare_queue('image_processing', durable=True)

@app.on_event("shutdown")
async def shutdown():
    await rabbitmq_channel.close()
    await rabbitmq_connection.close()

# Publish message
async def publish_message(queue_name: str, message: dict):
    await rabbitmq_channel.default_exchange.publish(
        aio_pika.Message(
            body=json.dumps(message).encode(),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,  # Survive broker restart
        ),
        routing_key=queue_name,
    )

# Example endpoint
@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    user_id = await db.create_user(user)

    # Async email sending
    await publish_message('email_queue', {
        'user_id': user_id,
        'email': user.email,
        'template': 'welcome'
    })

    return {"id": user_id}
```

### Worker Process

```python
# worker.py
import asyncio
import aio_pika

async def email_worker():
    connection = await aio_pika.connect_robust("amqp://user:pass@rabbitmq:5672/")
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=10)  # Process 10 at a time

    queue = await channel.declare_queue('email_queue', durable=True)

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                # Parse message
                data = json.loads(message.body.decode())

                try:
                    # Send email
                    await send_email(data['email'], data['template'])
                    print(f"✅ Sent email to {data['email']}")
                except Exception as e:
                    print(f"❌ Failed to send email: {e}")
                    # Message will be requeued if error raised
                    raise

if __name__ == "__main__":
    asyncio.run(email_worker())
```

---

## Message Patterns

### 1. Work Queue (Task Distribution)

```
Publisher → Queue → [Worker 1, Worker 2, Worker 3]
                    (Round-robin distribution)
```

**Use case:** Scale workers horizontally to handle load

### 2. Pub/Sub (Broadcast)

```
Publisher → Exchange → Queue A → Consumer A
                    → Queue B → Consumer B
                    → Queue C → Consumer C
```

**Use case:** Event notification to multiple services

### 3. Request/Reply (RPC)

```
Client → Request Queue → Worker
      ← Reply Queue   ←
```

**Use case:** Synchronous-style RPC over async transport

### 4. Delayed Messages

```
Publisher → Delayed Exchange → Queue (after delay) → Consumer
```

**Use case:** Scheduled tasks, retry with backoff

---

## Reliability Features

### 1. Message Persistence

```python
# Durable queue (survives broker restart)
await channel.declare_queue('my_queue', durable=True)

# Persistent message (survives broker restart)
await channel.default_exchange.publish(
    aio_pika.Message(
        body=json.dumps(data).encode(),
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
    ),
    routing_key='my_queue'
)
```

### 2. Acknowledgments

```python
# Manual acknowledgment (ensure message processed)
async for message in queue.iterator():
    try:
        await process_message(message)
        await message.ack()  # Success
    except Exception as e:
        await message.nack(requeue=True)  # Requeue on failure
```

### 3. Dead Letter Queue

```python
# Declare main queue with DLX
await channel.declare_queue(
    'main_queue',
    durable=True,
    arguments={
        'x-dead-letter-exchange': 'dlx',
        'x-dead-letter-routing-key': 'failed_messages',
        'x-message-ttl': 60000,  # 60 second TTL
        'x-max-retries': 3,
    }
)

# Declare dead letter queue
await channel.declare_queue('dead_letter_queue', durable=True)
```

---

## Monitoring

### Key Metrics

```bash
# RabbitMQ Management API
curl -u user:pass http://rabbitmq:15672/api/queues

# Key metrics:
- messages_ready: Messages waiting to be consumed
- messages_unacknowledged: Messages being processed
- message_stats.publish_details.rate: Publish rate (msg/sec)
- message_stats.deliver_details.rate: Consume rate (msg/sec)
```

### Prometheus Metrics

```promql
# Queue depth
rabbitmq_queue_messages{queue="email_queue"}

# Message rate
rate(rabbitmq_queue_messages_published_total{queue="email_queue"}[5m])
rate(rabbitmq_queue_messages_delivered_total{queue="email_queue"}[5m])

# Consumer count
rabbitmq_queue_consumers{queue="email_queue"}
```

### Alerts

```yaml
- alert: QueueDepthHigh
  expr: rabbitmq_queue_messages > 10000
  for: 5m
  annotations:
    summary: "Queue depth above 10k messages"

- alert: NoConsumers
  expr: rabbitmq_queue_consumers == 0
  for: 2m
  annotations:
    summary: "No consumers for queue - messages not being processed"

- alert: PublishRateExceedsConsume
  expr: |
    rate(rabbitmq_queue_messages_published_total[5m])
    > rate(rabbitmq_queue_messages_delivered_total[5m]) * 1.2
  for: 10m
  annotations:
    summary: "Messages accumulating in queue"
```

---

## Capacity Planning

### Message Throughput Formula

```
Messages per Second = (Worker Count × Messages per Worker per Second)

where:
  Worker Count = Number of consumer processes
  Messages per Worker per Second = 1 / Avg Message Processing Time

Example:
  Avg Processing Time = 100ms = 0.1s
  Messages per Worker = 1 / 0.1 = 10 msg/sec
  Workers = 5
  Total Throughput = 5 × 10 = 50 msg/sec
```

### Scaling Workers

```
Required Workers = (Message Rate / Messages per Worker per Second) * Safety Factor

Example (3,000 msg/sec):
  Message Rate = 3,000 msg/sec
  Avg Processing Time = 100ms (10 msg/sec per worker)
  Safety Factor = 1.5

  Required Workers = (3,000 / 10) * 1.5
  Required Workers = 450 workers

This is a lot! Optimize by:
  - Batch processing (process 10 messages at once)
  - Faster processing (reduce from 100ms to 50ms)
  - Horizontal scaling (spread workers across multiple servers)
```

---

## Cost Analysis (10k RPS with 30% queue usage)

```
Message Rate: 3,000 msg/sec

RabbitMQ Cluster (3 nodes):
  3 × c6i.xlarge = $240/month

Worker Instances (10 workers):
  10 × t3.medium = $300/month

Total RabbitMQ Infrastructure: $540/month

Full Stack Cost:
  API Servers: $520/month
  PostgreSQL: $2,075/month (with Redis, smaller DB)
  Redis: $360/month
  RabbitMQ: $540/month
  Load Balancers: $50/month
  Network: $150/month
  Total: $3,695/month

Compare to without RabbitMQ: $2,955/month
Additional Cost: $740/month

Benefits:
  - 95% faster API responses (no blocking)
  - Better user experience
  - Reliable async processing
  - Scalable background jobs
```

---

## Testing

### Load Test Queue Performance

```javascript
// k6 script
export default function() {
  // Publish message (fast)
  const payload = JSON.stringify({
    user_id: __VU,
    task: 'send_email',
    email: `user${__VU}@example.com`
  });

  const publishResponse = http.post(
    `${BASE_URL}/api/v1/queue/publish`,
    payload
  );

  check(publishResponse, {
    'publish successful': (r) => r.status === 202,
    'publish fast': (r) => r.timings.duration < 10,  // Should be very fast
  });
}
```

---

## Best Practices

1. **Idempotency:** Design message handlers to be idempotent (safe to process multiple times)
2. **Message Size:** Keep messages small (< 1 MB), use reference IDs for large data
3. **TTL:** Set message TTL to prevent infinite queuing
4. **Monitoring:** Alert on queue depth, consumer count, publish/consume rates
5. **Dead Letter Queues:** Always configure DLQ for failed messages
6. **Graceful Shutdown:** Ensure workers finish processing before shutdown

---

## Next Steps

1. Review [10k RPS Full Stack](./10krps/README.md) for complete configuration
2. See [Message Patterns](./patterns/messaging-patterns.md) for advanced usage
3. Load test with [full-stack-k6-tests](../../load-tests/k6/full-stack-10krps.js)

---

**Last Updated:** 2025-11-16
**Status:** Overview complete
