#!/bin/sh

set -e

echo "=========================================="
echo " Configurando MinIO"
echo "=========================================="

echo ""
echo "1. Conectando con MinIO..."

mc alias set \
  imagenuaq \
  http://minio:9000 \
  "$MINIO_ROOT_USER" \
  "$MINIO_ROOT_PASSWORD"


echo ""
echo "2. Creando bucket de documentos..."

mc mb \
  --ignore-existing \
  "imagenuaq/$MINIO_DOCUMENTS_BUCKET"


echo ""
echo "3. Creando bucket de temporales..."

mc mb \
  --ignore-existing \
  "imagenuaq/$MINIO_TEMP_BUCKET"


echo ""
echo "4. Configurando expiración de archivos temporales..."

mc ilm rule add \
  --expire-days "$MINIO_TEMP_EXPIRATION_DAYS" \
  "imagenuaq/$MINIO_TEMP_BUCKET" \
  2>/dev/null || true


echo ""
echo "=========================================="
echo " MinIO configurado correctamente"
echo "=========================================="


echo ""
echo "Buckets creados:"

mc ls imagenuaq


echo ""
echo "Reglas de lifecycle para temporales:"

mc ilm rule ls "imagenuaq/$MINIO_TEMP_BUCKET"