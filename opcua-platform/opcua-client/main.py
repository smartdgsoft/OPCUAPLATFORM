"""
OPC UA Client Service — Production Entry Point
Feature-flag driven. Enable/disable any module via .env.

FEATURE_WRITE=true/false       Write values to OPC UA nodes
FEATURE_METHODS=true/false     Call OPC UA Method nodes
FEATURE_MULTI_SERVER=true/false Multiple server connections
FEATURE_ALARM_EVAL=true/false  Real-time alarm evaluation engine
FEATURE_SCHEDULER=true/false   Scheduled reads/writes
KAFKA_ENABLED=true/false       Kafka ingestion pipeline
"""
from __future__ import annotations
import asyncio, json, os, signal
import structlog
from prometheus_client import start_http_server
from src.utils.logging import configure_logging
from src.config.settings import settings

FEATURE_WRITE       = os.getenv("FEATURE_WRITE",       "true").lower()  == "true"
FEATURE_METHODS     = os.getenv("FEATURE_METHODS",     "true").lower()  == "true"
FEATURE_MULTI_SERVER= os.getenv("FEATURE_MULTI_SERVER","false").lower() == "true"
FEATURE_ALARM_EVAL  = os.getenv("FEATURE_ALARM_EVAL",  "true").lower()  == "true"
FEATURE_SCHEDULER   = os.getenv("FEATURE_SCHEDULER",   "false").lower() == "true"

logger = structlog.get_logger(__name__)

async def main() -> None:
    configure_logging(settings.log_level)
    start_http_server(settings.metrics_port)
    logger.info("startup", metrics_port=settings.metrics_port,
        write=FEATURE_WRITE, methods=FEATURE_METHODS,
        multi_server=FEATURE_MULTI_SERVER, alarm_eval=FEATURE_ALARM_EVAL)

    ingest_queue: asyncio.Queue = asyncio.Queue(maxsize=50_000)

    import asyncpg, redis.asyncio as aioredis
    pg_dsn = settings.postgres_dsn.replace("postgresql+asyncpg://", "postgresql://")
    pg_pool = await asyncpg.create_pool(pg_dsn, min_size=3, max_size=10)
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

    from src.buffer.ingest_pipeline import IngestPipeline
    pipeline = IngestPipeline(ingest_queue)
    asyncio.create_task(pipeline.start())

    from src.servers.registry import OPCUAServerRegistry
    registry = OPCUAServerRegistry(ingest_queue, pg_pool, redis_client)
    asyncio.create_task(registry.start())
    await redis_client.set("opcua:client:pid", str(os.getpid()), ex=60)

    write_engine = None
    if FEATURE_WRITE:
        from src.writer.write_engine import WriteEngine
        write_engine = WriteEngine(registry, pg_pool, redis_client)
        asyncio.create_task(write_engine.start())
        asyncio.create_task(_write_listener(write_engine, redis_client))

    if FEATURE_METHODS:
        from src.methods.method_engine import MethodCallEngine
        method_engine = MethodCallEngine(registry, pg_pool, redis_client)
        await method_engine.load_templates()
        asyncio.create_task(_method_listener(method_engine, redis_client))

    if FEATURE_ALARM_EVAL:
        from src.alarms.alarm_evaluator import AlarmEvaluator
        asyncio.create_task(AlarmEvaluator(pg_pool, redis_client).start())

    if FEATURE_SCHEDULER:
        from src.scheduler.scheduler import TaskScheduler
        asyncio.create_task(TaskScheduler(registry, write_engine, pg_pool, redis_client).start())

    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    async def heartbeat():
        while not stop_event.is_set():
            await redis_client.set("opcua:client:heartbeat", "ok", ex=15)
            await redis_client.set("opcua:client:servers",
                json.dumps(registry.get_all_status()), ex=15)
            await asyncio.sleep(5)

    asyncio.create_task(heartbeat())
    logger.info("all_services_running")
    await stop_event.wait()
    await registry.stop()
    if write_engine: await write_engine.stop()
    await pipeline.stop()
    await pg_pool.close()
    await redis_client.aclose()
    logger.info("shutdown_complete")


async def _write_listener(write_engine, redis_client) -> None:
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("opcua:write:commands")
    async for msg in pubsub.listen():
        if msg["type"] != "message": continue
        try:
            cmd = json.loads(msg["data"])
            from src.writer.write_engine import WriteRequest, WritePriority
            req = WriteRequest(
                server_id=cmd["server_id"], node_id=cmd["node_id"],
                value=cmd["value"], data_type=cmd.get("data_type","Double"),
                priority=WritePriority(cmd.get("priority",2)),
                requested_by=cmd.get("requested_by","api"),
                request_id=cmd.get("request_id",""),
                min_value=cmd.get("min_value"), max_value=cmd.get("max_value"),
                confirm_readback=cmd.get("confirm_readback",True),
            )
            await write_engine.enqueue(req)
        except Exception as exc:
            logger.error("write_cmd_error", error=str(exc))


async def _method_listener(method_engine, redis_client) -> None:
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("opcua:method:commands")
    async for msg in pubsub.listen():
        if msg["type"] != "message": continue
        try:
            cmd = json.loads(msg["data"])
            if cmd.get("cmd") == "emergency_stop":
                await method_engine.emergency_stop(
                    server_id=cmd["server_id"],
                    stop_node_id=cmd["object_node_id"],
                    stop_method_node_id=cmd["method_node_id"],
                    requested_by=cmd.get("requested_by", "api"))
            elif cmd.get("template_id"):
                await method_engine.call_by_template(
                    cmd["template_id"], cmd.get("input_args",[]),
                    requested_by=cmd.get("requested_by","api"))
            else:
                from src.methods.method_engine import MethodCallRequest
                await method_engine.call(MethodCallRequest(
                    server_id=cmd["server_id"],
                    object_node_id=cmd["object_node_id"],
                    method_node_id=cmd["method_node_id"],
                    input_args=cmd.get("input_args",[]),
                    arg_types=cmd.get("arg_types",[]),
                    requested_by=cmd.get("requested_by","api"),
                    request_id=cmd.get("request_id",""),
                ))
        except Exception as exc:
            logger.error("method_cmd_error", error=str(exc))


if __name__ == "__main__":
    asyncio.run(main())
