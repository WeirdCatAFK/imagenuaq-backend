/**
 * Adaptador de almacenamiento para MinIO AIStor.
 * Su responsabilidad es traducir operaciones genéricas de
 * almacenamiento a operaciones compatibles con S3/MinIO.
 *
 * NO contiene lógica de Express.
 * NO contiene lógica de PostgreSQL.
 * NO decide permisos de usuarios.
 *
 * Arquitectura:
 *
 * resources/files.js
 * resources/folders.js
 *          ↓
 * storage/minioStorage.js
 *          ↓
 * storage/minio.js
 *          ↓
 *       MinIO AIStor
*/

import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

import { minio } from "./minio.js";

// CONFIGURACIÓN
const DOCUMENTS_BUCKET =
  process.env.MINIO_DOCUMENTS_BUCKET ?? "documentos";

// FUNCIONES AUXILIARES
async function bodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }

  // En Node.js, el stream devuelto por AWS SDK normalmente
  // dispone de transformToByteArray().
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();

    return Buffer.from(bytes);
  }

  // Compatibilidad con streams async iterables.
  const chunks = [];

  for await (const chunk of body) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

/**
 * Convierte metadata de AWS/MinIO a un objeto normal.
 */
function normalizeMetadata(metadata) {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      String(value),
    ])
  );
}

/**
 * Convierte la respuesta HeadObject a la estructura
 * que esperan los recursos.
 */
function normalizeObjectMetadata(response) {
  if (!response) {
    return null;
  }

  return {
    contentType:
      response.ContentType ?? "application/octet-stream",

    contentLength:
      response.ContentLength ?? 0,

    etag:
      response.ETag ?? null,

    lastModified:
      response.LastModified ?? null,

    metadata:
      normalizeMetadata(response.Metadata),
  };
}

/**
 * Convierte un error de MinIO/AWS a null cuando significa
 * que el objeto simplemente no existe.
 *
 * Los demás errores se vuelven a lanzar.
 */
function handleNotFound(error) {
  const code =
    error?.$metadata?.httpStatusCode ??
    error?.Code ??
    error?.code;

  if (
    code === 404 ||
    code === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NoSuchObject"
  ) {
    return null;
  }

  throw error;
}

/**
 * Valida que una clave de objeto sea válida.
 */
function validateKey(key) {
  if (
    typeof key !== "string" ||
    key.trim() === ""
  ) {
    throw new TypeError(
      "key debe ser una cadena no vacía."
    );
  }

  return key;
}

/**
 * Valida el contenido del bucket.
 */
function validateBucket(bucket) {
  if (
    typeof bucket !== "string" ||
    bucket.trim() === ""
  ) {
    throw new TypeError(
      "bucket debe ser una cadena no vacía."
    );
  }

  return bucket.trim();
}

/**
 * Devuelve el bucket que utilizará el adaptador.
 */
export function getDocumentsBucket() {
  return DOCUMENTS_BUCKET;
}

// ------------------------------------------------------
// PUT
// ------------------------------------------------------

/**
 * Crea o reemplaza un objeto en MinIO.
 *
 * Parámetros:
 *
 * {
 *   key,
 *   body,
 *   contentType,
 *   metadata
 * }
 *
 * También acepta:
 *
 * preserveExistingBody
 *
 * Cuando es true y body es undefined, primero obtiene
 * el contenido existente y después vuelve a subirlo.
 *
 * Esto permite que files.updateFile() pueda modificar
 * solamente los metadatos.
*/
export async function putObject({
  key,
  body,
  contentType,
  metadata = {},
  preserveExistingBody = false,
}) {
  validateKey(key);

  const bucket = getDocumentsBucket();

  /**
   * Cuando únicamente se actualizan los metadatos
   * y no se proporciona un nuevo body,
   * hacemos un COPY del objeto sobre sí mismo.
   *
   * Esto evita descargar y volver a subir archivos
   * grandes solamente para cambiar sus metadatos.
   */
  if (
    body === undefined &&
    preserveExistingBody
  ) {
    return replaceObjectMetadata({
      key,
      metadata,
      contentType,
    });
  }

  /**
   * Para crear o reemplazar completamente un archivo,
   * sí necesitamos recibir el contenido.
   */
  if (body === undefined || body === null) {
    throw new TypeError(
      "body es obligatorio para crear un objeto."
    );
  }

  const response = await minio.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: normalizeMetadata(metadata),
    })
  );

  return {
    key,
    etag: response.ETag ?? null,
  };
}

// ------------------------------------------------------
// GET
// ------------------------------------------------------

/**
 * Obtiene un objeto completo.
 *
 * Devuelve:
 *
 * {
 *   body,
 *   contentType,
 *   contentLength,
 *   etag,
 *   lastModified,
 *   metadata
 * }
 *
 * Si no existe, devuelve null.
 */
export async function getObject({
  key,
  bucket = DOCUMENTS_BUCKET,
}) {
  key = validateKey(key);
  bucket = validateBucket(bucket);

  try {
    const response = await minio.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    const body = await bodyToBuffer(
      response.Body
    );

    return {
      body,

      contentType:
        response.ContentType ??
        "application/octet-stream",

      contentLength:
        response.ContentLength ??
        body.length,

      etag:
        response.ETag ??
        null,

      lastModified:
        response.LastModified ??
        null,

      metadata:
        normalizeMetadata(
          response.Metadata
        ),
    };
  } catch (error) {
    return handleNotFound(error);
  }
}

// ------------------------------------------------------
// HEAD
// ------------------------------------------------------

/**
 * Obtiene únicamente los metadatos de un objeto.
 *
 * No descarga el contenido.
 *
 * Devuelve null si no existe.
 */
export async function headObject({
  key,
  bucket = DOCUMENTS_BUCKET,
}) {
  key = validateKey(key);
  bucket = validateBucket(bucket);

  try {
    const response = await minio.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    return normalizeObjectMetadata(
      response
    );
  } catch (error) {
    return handleNotFound(error);
  }
}

// ------------------------------------------------------
// LIST
// ------------------------------------------------------

/**
 * Lista objetos que comienzan con un prefijo.
 *
 * Ejemplo:
 *
 * prefix = "P-0427/"
 *
 * puede devolver:
 *
 * P-0427/solicitud.pdf
 * P-0427/Diseño/propuesta.pdf
 *
 * Cuando delimiter = "/":
 *
 * MinIO separa los resultados por niveles y devuelve
 * los prefijos comunes en CommonPrefixes.
 */
export async function listObjects({
  prefix = "",
  delimiter,
  limit = 100,
  continuationToken = null,
  bucket = DOCUMENTS_BUCKET,
}) {
  bucket = validateBucket(bucket);

  if (
    typeof prefix !== "string"
  ) {
    throw new TypeError(
      "prefix debe ser una cadena."
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new RangeError(
      "limit debe ser un entero entre 1 y 1000."
    );
  }

  const response = await minio.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,

      ...(delimiter
        ? { Delimiter: delimiter }
        : {}),

      MaxKeys: limit,

      ...(continuationToken
        ? {
            ContinuationToken:
              continuationToken,
          }
        : {}),
    })
  );

  const objects = (
    response.Contents ?? []
  ).map((object) => ({
    key: object.Key,

    size:
      object.Size ??
      0,

    etag:
      object.ETag ??
      null,

    lastModified:
      object.LastModified ??
      null,
  }));

  const prefixes = (
    response.CommonPrefixes ?? []
  )
    .map(
      (item) => item.Prefix
    )
    .filter(Boolean);

  return {
    objects,

    prefixes,

    nextToken:
      response.IsTruncated
        ? response.NextContinuationToken ?? null
        : null,
  };
}

// ------------------------------------------------------
// DELETE
// ------------------------------------------------------

/**
 * Elimina un objeto.
 *
 * MinIO/S3 considera exitosa la eliminación aunque el objeto
 * ya no exista, pero aquí hacemos primero un HEAD para que
 * el comportamiento sea más explícito para los recursos.
 */
export async function deleteObject({
  key,
  bucket = DOCUMENTS_BUCKET,
}) {
  key = validateKey(key);
  bucket = validateBucket(bucket);

  try {
    await minio.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    return {
      deleted: true,
      key,
    };
  } catch (error) {
    return handleNotFound(error);
  }
}

// ------------------------------------------------------
// COPY
// ------------------------------------------------------

/**
 * Copia un objeto dentro del mismo bucket.
 *
 * Se utiliza principalmente para:
 *
 * - renombrar archivos
 * - mover archivos
 * - renombrar carpetas
 * - mover carpetas
 *
 * En S3/MinIO, mover un objeto realmente significa:
 *
 * COPY + DELETE
 */
export async function copyObject({
  sourceKey,
  destinationKey,
  bucket = DOCUMENTS_BUCKET,
}) {
  sourceKey = validateKey(sourceKey);
  destinationKey = validateKey(destinationKey);
  bucket = validateBucket(bucket);

  /**
   * Source debe contener el bucket y la clave.
   *
   * Se utiliza encodeURIComponent por segmento para
   * manejar correctamente caracteres especiales.
   */
  const encodedSource = sourceKey
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment)
    )
    .join("/");

  const copySource =
    `/${bucket}/${encodedSource}`;

  try {
    const response = await minio.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        CopySource: copySource,
      })
    );

    return {
      sourceKey,
      destinationKey,

      etag:
        response.CopyObjectResult?.ETag ??
        null,
    };
  } catch (error) {
    return handleNotFound(error);
  }
}

export async function replaceObjectMetadata({
  key,
  metadata,
  contentType,
}) {
  validateKey(key);

  const bucket = getDocumentsBucket();

  const encodedSource = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const copySource = `/${bucket}/${encodedSource}`;

  const command = new CopyObjectCommand({
    Bucket: bucket,
    Key: key,
    CopySource: copySource,

    MetadataDirective: "REPLACE",

    Metadata: normalizeMetadata(metadata),

    ...(contentType
      ? {
          ContentType: contentType,
        }
      : {}),
  });

  try {
    const response = await minio.send(command);

    return {
      key,
      etag: response.CopyObjectResult?.ETag ?? null,
      lastModified:
        response.CopyObjectResult?.LastModified ?? null,
    };
  } catch (error) {
    handleNotFound(error, `No existe el objeto "${key}".`);
    throw error;
  }
}

// ------------------------------------------------------
// UTILIDADES ADICIONALES
// ------------------------------------------------------

/**
 * Comprueba si un objeto existe.
 *
 * Es un alias conveniente para los recursos.
 */
export async function objectExists({
  key,
  bucket = DOCUMENTS_BUCKET,
}) {
  const metadata = await headObject({
    key,
    bucket,
  });

  return metadata !== null;
}

/**
 * Devuelve información básica de un objeto.
 */
export async function statObject({
  key,
  bucket = DOCUMENTS_BUCKET,
}) {
  const metadata = await headObject({
    key,
    bucket,
  });

  if (!metadata) {
    return null;
  }

  return {
    key,
    ...metadata,
  };
}

/**
 * Crea un objeto marcador para representar una carpeta vacía.
 *
 * Ejemplo:
 *
 * key = "P-0427/Diseño/"
 *
 * El objeto tendrá:
 *
 * Content-Type: application/x-directory
 * Body: vacío
 */
export async function createFolderMarker({
  key,
  metadata = {},
  bucket = DOCUMENTS_BUCKET,
}) {
  key = validateKey(key);

  if (!key.endsWith("/")) {
    throw new TypeError(
      "La clave de una carpeta debe terminar con '/'."
    );
  }

  return putObject({
    key,
    body: new Uint8Array(0),
    contentType: "application/x-directory",
    metadata,
    bucket,
  });
}

/**
 * Exporta un objeto agrupado para utilizarlo directamente
 * como dependencia de los recursos.
 *
 * Ejemplo:
 *
 * import {
 *   createMinioStorage
 * } from "./storage/minioStorage.js";
 *
 * const storage = createMinioStorage();
 */
export function createMinioStorage({
  bucket = DOCUMENTS_BUCKET,
} = {}) {
  const normalizedBucket =
    validateBucket(bucket);

  return Object.freeze({
    putObject: (options) =>
      putObject({
        ...options,
        bucket: normalizedBucket,
    }),

    getObject: (options) =>
      getObject({
        ...options,
        bucket: normalizedBucket,
    }),

    headObject: (options) =>
      headObject({
        ...options,
        bucket: normalizedBucket,
    }),

    listObjects: (options) =>
      listObjects({
        ...options,
        bucket: normalizedBucket,
    }),

    deleteObject: (options) =>
      deleteObject({
        ...options,
        bucket: normalizedBucket,
    }),

    copyObject: (options) =>
      copyObject({
        ...options,
        bucket: normalizedBucket,
    }),

    replaceObjectMetadata: (options) =>
      replaceObjectMetadata({
        ...options,
        bucket: normalizedBucket,
    }),

  });
}