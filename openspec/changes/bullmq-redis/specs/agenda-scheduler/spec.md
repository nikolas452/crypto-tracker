## REMOVED Requirements

### Requirement: Agenda factory with an explicit role

**Reason**: Agenda is retired once the BullMQ migration is stable, and its dependencies are removed from the project.
**Migration**: Queue and worker construction is provided by the `queue-topology` and `queue-worker-lifecycle` capabilities.

### Requirement: Worker role registers and processes

**Reason**: Retired with Agenda.
**Migration**: The worker process creates BullMQ workers for the queues named in `WORKER_QUEUES`, as specified by `queue-worker-lifecycle`.

### Requirement: Producer role never processes

**Reason**: Retired with Agenda. The producer/consumer split survives as a property of queues rather than of a role flag: the API holds `Queue` instances and never creates a `Worker`.
**Migration**: The API enqueues through its `Queue` instances only; job processing happens exclusively in the worker process.

### Requirement: Single shared database connection

**Reason**: Retired with Agenda, together with the MongoDB driver version alignment it required.
**Migration**: Queue state lives in Redis, reached through `REDIS_URL`, as specified by `redis-infrastructure`.

### Requirement: Job names are centralized

**Reason**: Restated for queues rather than removed as a practice.
**Migration**: Queue and job names are centralized as shared constants under `queue-topology`.
