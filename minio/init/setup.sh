#!/bin/sh
# Creates the documents and photo buckets on first start, and caps the photo one with a hard
# quota so photo shoots cannot fill the documents space. Idempotent: --ignore-existing, and
# setting the quota again only replaces it.
set -e

mc alias set imagenuaq http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "imagenuaq/$MINIO_DOCUMENTS_BUCKET"
mc mb --ignore-existing "imagenuaq/$MINIO_PHOTOS_BUCKET"
mc quota set "imagenuaq/$MINIO_PHOTOS_BUCKET" --size "$MINIO_PHOTOS_QUOTA"
mc ls imagenuaq
