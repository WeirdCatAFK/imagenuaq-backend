import {
  S3Client,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";

/**
 * Cliente S3 para comunicarse con MinIO AIStor.
 *
 * En desarrollo, Express corre en el host y AIStor
 * está publicado en localhost:9000.
 *
 * Cuando Express se ejecute dentro de Docker junto con
 * AIStor, MINIO_ENDPOINT será http://minio:9000.
 */

const endpoint = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";

const accessKeyId = process.env.MINIO_ROOT_USER;
const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;

if (!accessKeyId || !secretAccessKey) {
  throw new Error(
    "MINIO_ROOT_USER y MINIO_ROOT_PASSWORD son requeridos para conectarse a MinIO."
  );
}

export const minio = new S3Client({
  endpoint,

  region: "us-east-1",

  credentials: {
    accessKeyId,
    secretAccessKey,
  },

  forcePathStyle: true,
});


/**
 * Comprueba que el backend puede comunicarse con MinIO.
 *
 * Esta función se utilizará temporalmente para probar
 * la conexión antes de integrar el almacenamiento
 * con las rutas reales de la aplicación.
 */
export async function checkMinioConnection() {
  const response = await minio.send(
    new ListBucketsCommand({})
  );

  return response.Buckets ?? [];
}