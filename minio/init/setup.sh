#!/bin/sh
# Creates the documents bucket on first start. Idempotent: --ignore-existing.
set -e

mc alias set imagenuaq http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "imagenuaq/$MINIO_DOCUMENTS_BUCKET"
mc ls imagenuaq
