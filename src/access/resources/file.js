/**
 * Responsabilidad:
 * - Administrar las operaciones CRUD de archivos.
 * - Construir las claves de almacenamiento a partir de la clave
 *   del proyecto, la carpeta y el nombre del archivo.
 * - Validar los datos antes de enviarlos al almacenamiento.
 *
 * Este módulo NO depende de Express ni de PostgreSQL.
 * 
 * La dependencia "storage" se inyecta desde fuera. Así, este recurso
 * puede utilizar MinIO u otro proveedor sin cambiar su lógica.
 *
 * Las operaciones del proveedor deben devolver Promises.
*/

/**
 * VALIDACIONES Y FUNCIONES AUXILIARES
 */

/**
 * Ve q un valor sea una cadena no vacía.
 */
function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `${fieldName} debe ser una cadena no vacía.`
    );
  }

  return value.trim();
}

/**
 * Valida un segmento de ruta.
 * Nombres:
 * Impide que los nombres introduzcan rutas absolutas,
 * segmentos "." o "..", o separadores de directorios.
 *
 * Se utiliza para projectKey, folderPath y fileName.
*/

function validateSegment(value, fieldName) {
  const segment = requireString(value, fieldName);

  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new TypeError(
      `${fieldName} contiene un segmento de ruta no permitido.`
    );
  }

  return segment;
}

/**
 * Valida la clave del proyecto.
*/
function normalizeProjectKey(projectKey) {
  return validateSegment(projectKey, "projectKey");
}

/**
 * Normaliza una ruta de carpeta relativa al proyecto.
 *
 * Acepta:
 * "Diseño"
 * "Diseño/Propuestas"
 *
 * Devuelve la ruta sin "/" al inicio ni al final.
 * Una cadena vacía representa la raíz del proyecto.
*/

function normalizeFolderPath(folderPath = "") {
  if (folderPath === "" || folderPath === null) {
    return "";
  }

  const path = requireString(folderPath, "folderPath")
    .replace(/\\/g, "/") 
    .replace(/^\/+|\/+$/g, "");
    //^incio string y $fin cadena
    // "\/" busca una O más barras normales "/" (si se deja solo "/" sin "\/" solo delimita la expresión regular) 
    //"/ /g" expresión para reemplazar TODAS la conincidencias encontradas seguido de la coma para reemplazar con lo que se indique

  if (!path) {
    return "";
  }

  const segments = path.split("/");

  return segments
    .map((segment) => validateSegment(segment, "folderPath"))
    .join("/");
}

/**
 * Construye la clave completa de un archivo.
 *
 * Ejemplos:
 * buildFileKey({
 *   projectKey: "P-0427",
 *   fileName: "solicitud.pdf"
 * })
 * => "P-0427/solicitud.pdf"
 *
 * buildFileKey({
 *   projectKey: "P-0427",
 *   folderPath: "Diseño",
 *   fileName: "logo.png"
 * })
 * => "P-0427/Diseño/logo.png"
 */
export function buildFileKey({
  projectKey,
  folderPath = "",
  fileName,
}) {
  const project = normalizeProjectKey(projectKey);
  const folder = normalizeFolderPath(folderPath);
  const file = validateSegment(fileName, "fileName");

  return [project, folder, file]
    .filter(Boolean)
    .join("/");
}

/**
 * Extrae el nombre del archivo de una clave completa.
 */
export function getFileName(key) {
  const normalizedKey = requireString(key, "key")
    .replace(/\\/g, "/");

  return normalizedKey.split("/").pop();
}

/**
 * Devuelve la extensión de un archivo, incluyendo el punto.
 *
 * Ejemplo: "propuesta.pdf" => ".pdf"
 * Si no hay extensión, devuelve una cadena vacía.
 */
export function getFileExtension(fileName) {
  const name = validateSegment(fileName, "fileName");
  const lastDot = name.lastIndexOf(".");

  if (lastDot <= 0 || lastDot === name.length - 1) {
    return "";
  }

  return name.slice(lastDot).toLowerCase();
}

/**
 * Obtiene el prefijo correspondiente a un proyecto.
 */
export function getProjectFilePrefix(projectKey) {
  return `${normalizeProjectKey(projectKey)}/`;
}

/**
 * Comprueba que se haya proporcionado un adaptador de almacenamiento
 * con todas las operaciones necesarias.
 */
function validateStorage(storage) {
  const requiredMethods = [
    "putObject",
    "getObject",
    "headObject",
    "listObjects",
    "deleteObject",
    "copyObject",
  ];

  if (!storage || typeof storage !== "object") {
    throw new TypeError(
      "Debes proporcionar una implementación de storage."
    );
  }

  for (const method of requiredMethods) {
    if (typeof storage[method] !== "function") {
      throw new TypeError(
        `storage debe implementar el método ${method}().`
      );
    }
  }
}

/**
 * Valida el contenido que se almacenará.
 *
 * El adaptador debe aceptar los tipos de contenido que la aplicación
 * decida soportar, por ejemplo Buffer, Uint8Array o Readable.
 *
 * Esta validación no consume ni lee el contenido.
 */
function validateFileBody(body) {
  if (body === undefined || body === null) {
    throw new TypeError(
      "El contenido del archivo es requerido."
    );
  }

  if (
    typeof body !== "string" &&
    !Buffer.isBuffer(body) &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer)
  ) {
    throw new TypeError(
      "El contenido debe ser string, Buffer, Uint8Array o ArrayBuffer."
    );
  }

  return body;
}

/**
 * Normaliza los metadatos que se enviarán al almacenamiento.
 *
 * No se utiliza para guardar permisos ni información de autorización.
 */
function normalizeMetadata(metadata = {}) {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new TypeError("metadata debe ser un objeto.");
  }

  return { ...metadata };
}

/**
 * Valida los parámetros comunes de paginación.
 */
function normalizePagination({ limit = 100, continuationToken = null } = {}) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new RangeError(
      "limit debe ser un entero entre 1 y 1000."
    );
  }

  if (
    continuationToken !== null &&
    typeof continuationToken !== "string"
  ) {
    throw new TypeError(
      "continuationToken debe ser una cadena o null."
    );
  }

  return { limit, continuationToken };
}

// ------------------------------------------------------
// CRUD FILES
// ------------------------------------------------------

/**
 * Crea el recurso de archivos utilizando un adaptador de almacenamiento.
 **/
export function createFilesResource(storage) {
  validateStorage(storage);

  // ----------------------------------------------------
  // CREATE
  // ----------------------------------------------------

  /**
   * Crea o almacena un archivo dentro de un proyecto.
   *
   * Parámetros:
   * - projectKey: clave del proyecto.
   * - folderPath: ruta relativa opcional dentro del proyecto.
   * - fileName: nombre del archivo.
   * - body: contenido del archivo.
   * - contentType: MIME type opcional.
   * - metadata: metadatos adicionales.
   *
    */

  async function createFile({
    projectKey,
    folderPath = "",
    fileName,
    body,
    contentType = "application/octet-stream",
    metadata = {},
  }) {
    const key = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    validateFileBody(body);

    if (
      typeof contentType !== "string" ||
      contentType.trim() === ""
    ) {
      throw new TypeError(
        "contentType debe ser una cadena no vacía."
      );
    }

    // Comprueba previamente si ya existe.
    const existing = await storage.headObject({ key });

    if (existing) {
      const error = new Error(
        `Ya existe un archivo con la clave "${key}".`
      );
      error.code = "EFILEEXISTS";
      throw error;
    }

    const result = await storage.putObject({
      key,
      body,
      contentType: contentType.trim(),
      metadata: normalizeMetadata(metadata),
    });

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      fileName: validateSegment(fileName, "fileName"),
      contentType: contentType.trim(),
      ...result,
    };
  }

  // ----------------------------------------------------
  // READ
  // ----------------------------------------------------

  /*Obtiene un archivo por su clave completa.*/
  async function getFile({
    projectKey,
    folderPath = "",
    fileName,
  }) {
    const key = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    const file = await storage.getObject({ key });

    if (file === null || file === undefined) {
      const error = new Error(
        `No se encontró el archivo "${key}".`
      );
      error.code = "EFILE_NOT_FOUND";
      throw error;
    }

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      fileName: validateSegment(fileName, "fileName"),
      ...file,
    };
  }

  /**
   * Obtiene los metadatos de un archivo sin descargar su contenido.
   * Devuelve null si no existe.
   */
  async function getFileMetadata({
    projectKey,
    folderPath = "",
    fileName,
  }) {
    const key = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    const metadata = await storage.headObject({ key });

    if (!metadata) {
      return null;
    }

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      fileName: validateSegment(fileName, "fileName"),
      ...metadata,
    };
  }

  /**
   * Lista archivos dentro de una carpeta de un proyecto.
   * Si folderPath está vacío, lista desde la raíz del proyecto.
   * recursive=true incluye archivos de subcarpetas.
   * El adaptador debe respetar el prefijo
   */
  async function listFiles({
    projectKey,
    folderPath = "",
    recursive = false,
    limit = 100,
    continuationToken = null,
  }) {
    const project = normalizeProjectKey(projectKey);
    const folder = normalizeFolderPath(folderPath);
    const pagination = normalizePagination({
      limit,
      continuationToken,
    });

    const prefix = folder
      ? `${project}/${folder}/`
      : `${project}/`;

    const response = await storage.listObjects({
      prefix,
      delimiter: recursive ? undefined : "/",
      ...pagination,
    });

    const objects = response?.objects ?? [];

    return {
      projectKey: project,
      folderPath: folder,
      files: objects.filter((object) => {
        // Excluye los marcadores usados para representar
        // carpetas, si el proveedor los devuelve en el listado.
        return !String(object.key ?? "").endsWith("/");
      }),
      nextToken: response?.nextToken ?? null,
    };
  }

  /**
   * Lista todos los archivos de un proyecto, incluyendo
   * los que se encuentran dentro de sus subcarpetas.
   */
  async function listProjectFiles({
    projectKey,
    limit = 100,
    continuationToken = null,
  }) {
    return listFiles({
      projectKey,
      folderPath: "",
      recursive: true,
      limit,
      continuationToken,
    });
  }

  /**
   * Comprueba si existe un archivo.
   */
  async function fileExists({
    projectKey,
    folderPath = "",
    fileName,
  }) {
    const metadata = await getFileMetadata({
      projectKey,
      folderPath,
      fileName,
    });

    return metadata !== null;
  }

  // ----------------------------------------------------
  // UPDATE
  // ----------------------------------------------------

  /**
   * Actualiza el contenido o los metadatos de un archivo.
   *
   * Para reemplazar el contenido, proporciona body.
   * Para cambiar el MIME type, proporciona contentType.
   * Para cambiar metadatos, proporciona metadata.
   *
   * Los campos omitidos conservan su valor cuando el
   * adaptador puede hacerlo; de lo contrario, el adaptador
   * debe recuperar y preservar los metadatos existentes.
   *
   * Esta operación NO renombra el archivo. Para ello,
   * utiliza renameFile().
   */
  async function updateFile({
    projectKey,
    folderPath = "",
    fileName,
    body,
    contentType,
    metadata,
  }) {
    const key = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    const existing = await storage.headObject({ key });

    if (!existing) {
      const error = new Error(
        `No se puede actualizar: no existe "${key}".`
      );
      error.code = "EFILE_NOT_FOUND";
      throw error;
    }

    if (body === undefined && contentType === undefined &&
        metadata === undefined) {
      throw new TypeError(
        "Debes proporcionar body, contentType o metadata para actualizar."
      );
    }

    // Para cambiar únicamente metadatos, el adaptador debe
    // conservar el contenido original al reemplazar el objeto.
    // Se pasa body como undefined cuando no se quiere cambiar.
    const result = await storage.putObject({
      key,
      body: body === undefined
        ? undefined
        : validateFileBody(body),
      contentType:
        contentType === undefined
          ? existing.contentType ?? "application/octet-stream"
          : requireString(contentType, "contentType"),
      metadata:
        metadata === undefined
          ? existing.metadata ?? {}
          : normalizeMetadata(metadata),
      preserveExistingBody: body === undefined,
    });

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      fileName: validateSegment(fileName, "fileName"),
      ...result,
    };
  }

  /**
   * Renombra un archivo o lo mueve a otra carpeta del mismo proyecto.
   */
  async function renameFile({
    projectKey,
    folderPath = "",
    fileName,
    newFileName,
    newFolderPath = folderPath,
  }) {
    const sourceKey = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    const destinationKey = buildFileKey({
      projectKey,
      folderPath: newFolderPath,
      fileName: newFileName,
    });

    if (sourceKey === destinationKey) {
      return { key: sourceKey, unchanged: true };
    }

    const source = await storage.headObject({
      key: sourceKey,
    });

    if (!source) {
      const error = new Error(
        `No se encontró el archivo "${sourceKey}".`
      );
      error.code = "EFILE_NOT_FOUND";
      throw error;
    }

    const destination = await storage.headObject({
      key: destinationKey,
    });

    if (destination) {
      const error = new Error(
        `Ya existe el archivo de destino "${destinationKey}".`
      );
      error.code = "EFILEEXISTS";
      throw error;
    }

    await storage.copyObject({
      sourceKey,
      destinationKey,
    });

    await storage.deleteObject({
      key: sourceKey,
    });

    return {
      previousKey: sourceKey,
      key: destinationKey,
      projectKey: normalizeProjectKey(projectKey),
      fileName: validateSegment(newFileName, "newFileName"),
      folderPath: normalizeFolderPath(newFolderPath),
    };
  }

  // ----------------------------------------------------
  // DELETE
  // ----------------------------------------------------

  /**
   * Elimina un archivo.
   */
  async function deleteFile({
    projectKey,
    folderPath = "",
    fileName,
  }) {
    const key = buildFileKey({
      projectKey,
      folderPath,
      fileName,
    });

    const existing = await storage.headObject({ key });

    if (!existing) {
      const error = new Error(
        `No se puede eliminar: no existe "${key}".`
      );
      error.code = "EFILE_NOT_FOUND";
      throw error;
    }

    await storage.deleteObject({ key });

    return {
      deleted: true,
      key,
    };
  }

  // ----------------------------------------------------
  // API PÚBLICA DEL RECURSO
  // ----------------------------------------------------

  return Object.freeze({
    createFile,
    getFile,
    getFileMetadata,
    listFiles,
    listProjectFiles,
    fileExists,
    updateFile,
    renameFile,
    deleteFile,
  });
}