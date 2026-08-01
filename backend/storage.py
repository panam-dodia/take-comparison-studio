import uuid

import boto3
from genblaze_core import KeyStrategy, ObjectStorageSink
from genblaze_s3 import S3StorageBackend

from . import config


def _public_url_base(bucket: str, region: str) -> str:
    """Backblaze's native "friendly" download host encodes the region
    number, e.g. us-west-004 -> f004.backblazeb2.com, us-east-005 -> f005.
    Only valid for buckets set to Public — see backend/storage.py callers.
    """
    region_num = region.rsplit("-", 1)[-1]
    return f"https://f{region_num}.backblazeb2.com/file/{bucket}"


def build_sink() -> ObjectStorageSink | None:
    """Real B2 storage sink, or None to run the pipeline with no upload.

    B2's free tier (10GB) costs nothing, so this stays wired up even in
    GENBLAZE_MOCK=true mode — only the generation calls are mocked.

    The bucket must be Public: GMI Cloud's video models fetch the reference
    image URL server-side for image-conditioning, and the frontend's own
    <img>/<video> tags load asset URLs directly — neither can authenticate,
    so a Private bucket's unsigned URLs 404/401 for both.
    """
    if not config.STORAGE_ENABLED:
        return None
    backend = S3StorageBackend.for_backblaze(
        config.B2_BUCKET,
        region=config.B2_REGION,
        public_url_base=_public_url_base(config.B2_BUCKET, config.B2_REGION),
    )
    return ObjectStorageSink(backend, prefix="takes", key_strategy=KeyStrategy.HIERARCHICAL)


def upload_user_reference(data: bytes, filename: str, content_type: str) -> str:
    """Upload a user-supplied reference image straight to B2 via the raw
    S3-compatible API — bypasses genblaze's Pipeline/manifest machinery
    since there's no generation here to record provenance for, just the
    caller's own file."""
    if not config.STORAGE_ENABLED:
        raise RuntimeError("B2 storage is not configured — set B2_KEY_ID/B2_APP_KEY/B2_BUCKET in .env")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://s3.{config.B2_REGION}.backblazeb2.com",
        aws_access_key_id=config.B2_KEY_ID,
        aws_secret_access_key=config.B2_APP_KEY,
        region_name=config.B2_REGION,
    )
    key = f"uploads/{uuid.uuid4().hex}-{filename}"
    client.put_object(Bucket=config.B2_BUCKET, Key=key, Body=data, ContentType=content_type)
    return f"{_public_url_base(config.B2_BUCKET, config.B2_REGION)}/{key}"
