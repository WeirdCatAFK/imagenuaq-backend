import "dotenv/config";
import { checkMinioConnection } from "./src/storage/minio.js";

try {
  const buckets = await checkMinioConnection();

  console.log("Conexión con MinIO exitosa.");
  console.log("Buckets:");

  for (const bucket of buckets) {
    console.log(`- ${bucket.Name}`);
  }
} catch (error) {
  console.error("No se pudo conectar con MinIO.");
  console.error(error);
  process.exit(1);
}