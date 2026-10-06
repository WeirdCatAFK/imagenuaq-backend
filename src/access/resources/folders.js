
/**
 * Responsabilidad:
 * - Administrar las operaciones CRUD de carpetas.
 * - Construir las rutas a partir de la clave del proyecto.
 * - Crear y consultar carpetas lógicas.
 * - Listar subcarpetas y administrar su contenido.
 * - Renombrar y eliminar carpetas.
 *
 * Este módulo NO depende de Express ni de PostgreSQL.
 *
 * IMPORTANTE:
 * Los proveedores de objetos, como MinIO/S3, no utilizan
 * directorios reales. Las carpetas se representan mediante
 * prefijos y, para conservar carpetas vacías, marcadores
 * cuyo nombre termina en "/".
 *
 * Para carpetas, el adaptador debe poder identificar
 * los marcadores terminados en "/" y los prefijos comunes.
*/

/**
 * VALIDACIONES Y FUNCIONES AUXILIARES
*/

//Valida una cadena obligatoria
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
 *
 * No permite separadores, segmentos "." o ".." ni
 * caracteres nulos dentro de un nombre.
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

//Normaliza la clave del proyecto.
function normalizeProjectKey(projectKey) {
  return validateSegment(projectKey, "projectKey");
}

/**
 * Normaliza una ruta relativa de carpeta.
 *
 * Ejemplos:
 * "Diseño" => "Diseño"
 * "Diseño/Propuestas" => "Diseño/Propuestas"
 * "" => ""
*/
function normalizeFolderPath(folderPath = "") {
  if (folderPath === "" || folderPath === null) {
    return "";
  }

  const path = requireString(folderPath, "folderPath")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (!path) {
    return "";
  }

  return path
    .split("/")
    .map((segment) => validateSegment(segment, "folderPath"))
    .join("/");
}

//Valida el adaptador de almacenamiento.
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

//Construye el prefijo de un proyecto.
export function getProjectFolderPrefix(projectKey) {
  return `${normalizeProjectKey(projectKey)}/`;
}

/**
 * Construye la clave de una carpeta.
 *
 * Ejemplos:
 * buildFolderKey({
 *   projectKey: "P-0427",
 *   folderName: "Diseño"
 * })
 * => "P-0427/Diseño/"
 *
 * buildFolderKey({
 *   projectKey: "P-0427",
 *   folderPath: "Diseño",
 *   folderName: "Propuestas"
 * })
 * => "P-0427/Diseño/Propuestas/"
*/
export function buildFolderKey({
  projectKey,
  folderPath = "",
  folderName,
}) {
  const project = normalizeProjectKey(projectKey);
  const parent = normalizeFolderPath(folderPath);
  const name = validateSegment(folderName, "folderName");

  return `${[project, parent, name]
    .filter(Boolean)
    .join("/")}/`;
}

/**
 * Construye la clave de una carpeta a partir de su ruta completa
 * relativa al proyecto.
 *
 * Ejemplo:
 * buildFolderKeyFromPath({
 *   projectKey: "P-0427",
 *   folderPath: "Diseño/Propuestas"
 * })
 * => "P-0427/Diseño/Propuestas/"
 *
 * La raíz del proyecto se representa mediante "P-0427/".
*/
export function buildFolderKeyFromPath({
  projectKey,
  folderPath = "",
}) {
  const project = normalizeProjectKey(projectKey);
  const folder = normalizeFolderPath(folderPath);

  return folder
    ? `${project}/${folder}/`
    : `${project}/`;
}

/**
 * Obtiene el nombre de una carpeta desde su clave.
 *
 * Ejemplo:
 * "P-0427/Diseño/Propuestas/" => "Propuestas"
*/
export function getFolderName(key) {
  const normalizedKey = requireString(key, "key")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  return normalizedKey.split("/").pop();
}

/**
 * Obtiene la ruta de una carpeta, relativa al proyecto.
 *
 * Ejemplo:
 * getRelativeFolderPath("P-0427/Diseño/Propuestas/")
 * => "Diseño/Propuestas"
 *
 * Esta función extrae la ruta relativa, pero no verifica
 * que la clave pertenezca a un proyecto específico.
*/

export function getRelativeFolderPath(key) {
  const normalizedKey = requireString(key, "key")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  const segments = normalizedKey.split("/");

  if (segments.length < 2) {
    return "";
  }

  return segments.slice(1).join("/");
}

//Normaliza los parámetros de paginación.
function normalizePagination({
  limit = 100,
  continuationToken = null,
} = {}) {
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

/**
 * Obtiene todos los objetos que coinciden con un prefijo,
 * recorriendo todas las páginas del almacenamiento.
 *
 * Esta función auxiliar es útil para operaciones recursivas,
 * como renombrar o eliminar una carpeta con su contenido.
*/

async function listAllObjects(storage, prefix) {
  const objects = [];
  let continuationToken = null;

  do {
    const response = await storage.listObjects({
      prefix,
      limit: 1000,
      continuationToken,
    });

    objects.push(...(response?.objects ?? []));

    continuationToken = response?.nextToken ?? null;
  } while (continuationToken);

  return objects;
}

/**
 * Verifica si una clave representa una carpeta.
 *
 * El marcador debe terminar en "/" y estar dentro del proyecto.
 */
function isFolderMarker(key, projectKey) {
  const projectPrefix = `${normalizeProjectKey(projectKey)}/`;

  return (
    typeof key === "string" &&
    key.startsWith(projectPrefix) &&
    key.endsWith("/")
  );
}

/*------------------------------------------------------
// CRUD CARPETAS
------------------------------------------------------*/

//Crea el recurso de carpetas.
export function createFoldersResource(storage) {
  validateStorage(storage);

  // ----------------------------------------------------
  // CREATE
  // ----------------------------------------------------

  /**
   * Crea una carpeta dentro de un proyecto.
   *
   * Si folderPath es proporcionado, crea la carpeta
   * dentro de esa ruta relativa.
   *
   * La operación crea un marcador vacío para que la carpeta
   * exista incluso cuando todavía no contiene archivos.
   *
   * El adaptador debe soportar escritura condicional si se
   * necesita impedir duplicados bajo operaciones concurrentes.
   */
  async function createFolder({
    projectKey,
    folderPath = "",
    folderName,
    metadata = {},
  }) {
    const key = buildFolderKey({
      projectKey,
      folderPath,
      folderName,
    });

    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      throw new TypeError("metadata debe ser un objeto.");
    }

    const existing = await storage.headObject({ key });

    if (existing) {
      const error = new Error(
        `Ya existe la carpeta "${key}".`
      );
      error.code = "EFOLDEREXISTS";
      throw error;
    }

    // El cuerpo vacío representa el marcador de la carpeta.
    await storage.putObject({
      key,
      body: new Uint8Array(0),
      contentType: "application/x-directory",
      metadata: { ...metadata },
    });

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      folderName: validateSegment(folderName, "folderName"),
      created: true,
    };
  }

  // ----------------------------------------------------
  // READ
  // ----------------------------------------------------

  /**
   * Consulta una carpeta por su nombre y su ruta padre.
   *
   * Devuelve sus metadatos si existe el marcador.
   * Devuelve null si el marcador no existe.
   *
   * Una carpeta sin marcador podría seguir existiendo
   * como prefijo implícito si contiene archivos.
   */
  async function getFolder({
    projectKey,
    folderPath = "",
    folderName,
  }) {
    const key = buildFolderKey({
      projectKey,
      folderPath,
      folderName,
    });

    const metadata = await storage.headObject({ key });

    if (!metadata) {
      return null;
    }

    return {
      key,
      projectKey: normalizeProjectKey(projectKey),
      folderPath: normalizeFolderPath(folderPath),
      folderName: validateSegment(folderName, "folderName"),
      ...metadata,
    };
  }

  /**
   * Lista las subcarpetas inmediatas de una ruta.
   *
   * Si folderPath está vacío, lista las carpetas de la raíz
   * del proyecto.
   *
   * No incluye las carpetas de niveles inferiores en la lista.
   */
  async function listFolders({
    projectKey,
    folderPath = "",
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
      delimiter: "/",
      ...pagination,
    });

    const folders = new Map();

    // Los prefijos comunes permiten identificar carpetas
    // que contienen archivos o subcarpetas.
    for (const folderPrefix of response?.prefixes ?? []) {
      if (
        typeof folderPrefix !== "string" ||
        !folderPrefix.startsWith(prefix)
      ) {
        continue;
      }

      const relative = folderPrefix
        .slice(prefix.length)
        .replace(/\/+$/, "");

      // Solo se admite un segmento para obtener
      // las carpetas inmediatas.
      if (relative && !relative.includes("/")) {
        folders.set(folderPrefix, {
          key: folderPrefix,
          folderName: relative,
          folderPath: folder,
          projectKey: project,
          explicit: false,
        });
      }
    }

    // También se incluyen los marcadores explícitos.
    for (const object of response?.objects ?? []) {
      const key = object.key;

      if (!isFolderMarker(key, project)) {
        continue;
      }

      const relative = key
        .slice(prefix.length)
        .replace(/\/+$/, "");

      if (relative && !relative.includes("/")) {
        folders.set(key, {
          key,
          folderName: relative,
          folderPath: folder,
          projectKey: project,
          explicit: true,
          ...object,
        });
      }
    }

    return {
      projectKey: project,
      folderPath: folder,
      folders: [...folders.values()],
      nextToken: response?.nextToken ?? null,
    };
  }

  /**
   * Lista las carpetas de un proyecto de forma recursiva.
   *
   * Recorre las páginas del proveedor y devuelve las rutas
   * de carpetas encontradas en los prefijos y marcadores.
   */
  async function listProjectFolders({ projectKey }) {
    const project = normalizeProjectKey(projectKey);
    const prefix = `${project}/`;

    const objects = await listAllObjects(storage, prefix);
    const folders = new Map();

    for (const object of objects) {
      const key = object.key;

      if (typeof key !== "string" || !key.startsWith(prefix)) {
        continue;
      }

      const relative = key.slice(prefix.length);

      // Los marcadores representan carpetas explícitas.
      if (relative.endsWith("/")) {
        const parts = relative
          .replace(/\/+$/, "")
          .split("/");

        let accumulated = "";

        for (const part of parts) {
          accumulated = accumulated
            ? `${accumulated}/${part}`
            : part;

          const folderKey = `${prefix}${accumulated}/`;

          folders.set(folderKey, {
            key: folderKey,
            folderName: part,
            folderPath: accumulated,
            projectKey: project,
          });
        }

        continue;
      }

      // Los archivos también permiten inferir las carpetas
      // que no cuentan con marcador explícito.
      const parts = relative.split("/");

      if (parts.length < 2) {
        continue;
      }

      let accumulated = "";

      for (const part of parts.slice(0, -1)) {
        accumulated = accumulated
          ? `${accumulated}/${part}`
          : part;

        const folderKey = `${prefix}${accumulated}/`;

        folders.set(folderKey, {
          key: folderKey,
          folderName: part,
          folderPath: accumulated,
          projectKey: project,
        });
      }
    }

    return {
      projectKey: project,
      folders: [...folders.values()],
    };
  }

  /**
   * Comprueba si una carpeta existe.
   *
   * Considera existente una carpeta si tiene un marcador
   * explícito o si contiene objetos bajo su prefijo.
   */
  async function folderExists({
    projectKey,
    folderPath = "",
    folderName,
  }) {
    const key = buildFolderKey({
      projectKey,
      folderPath,
      folderName,
    });

    const marker = await storage.headObject({ key });

    if (marker) {
      return true;
    }

    const response = await storage.listObjects({
      prefix: key,
      limit: 1,
    });

    return (
      (response?.objects?.length ?? 0) > 0 ||
      (response?.prefixes?.length ?? 0) > 0
    );
  }

  // ----------------------------------------------------
  // UPDATE
  // ----------------------------------------------------

  /**
   * Renombra o mueve una carpeta dentro del mismo proyecto.
   *
   * Copia los objetos de la carpeta a su nuevo prefijo y,
   * después, elimina los objetos de la ubicación anterior.
   *
   * Si ocurre un error durante la operación, podrían quedar
   * objetos en ambas ubicaciones. Para grandes volúmenes,
   * conviene implementar este proceso como una operación
   * reanudable y con registro de progreso.
   */
  async function renameFolder({
    projectKey,
    folderPath = "",
    folderName,
    newFolderName,
    newParentPath = folderPath,
  }) {
    const sourceKey = buildFolderKey({
      projectKey,
      folderPath,
      folderName,
    });

    const destinationKey = buildFolderKey({
      projectKey,
      folderPath: newParentPath,
      folderName: newFolderName,
    });

    if (sourceKey === destinationKey) {
      return {
        key: sourceKey,
        unchanged: true,
      };
    }

    // Impide mover una carpeta dentro de sí misma.
    if (destinationKey.startsWith(sourceKey)) {
      throw new TypeError(
        "No puedes mover una carpeta dentro de sí misma."
      );
    }

    const sourceObjects = await listAllObjects(
      storage,
      sourceKey
    );

    const sourceMarker = await storage.headObject({
      key: sourceKey,
    });

    if (!sourceMarker && sourceObjects.length === 0) {
      const error = new Error(
        `No se encontró la carpeta "${sourceKey}".`
      );
      error.code = "EFOLDER_NOT_FOUND";
      throw error;
    }

    const destinationObjects = await listAllObjects(
      storage,
      destinationKey
    );

    const destinationMarker = await storage.headObject({
      key: destinationKey,
    });

    if (destinationMarker || destinationObjects.length > 0) {
      const error = new Error(
        `Ya existe contenido en "${destinationKey}".`
      );
      error.code = "EFOLDEREXISTS";
      throw error;
    }

    // Incluye el marcador de origen si existe.
    const sourceKeys = new Set(
      sourceObjects
        .map((object) => object.key)
        .filter((key) => typeof key === "string")
    );

    if (sourceMarker) {
      sourceKeys.add(sourceKey);
    }

    // Primero se copian todos los objetos.
    for (const oldKey of sourceKeys) {
      const newKey =
        destinationKey + oldKey.slice(sourceKey.length);

      await storage.copyObject({
        sourceKey: oldKey,
        destinationKey: newKey,
      });
    }

    // Solo después de copiar correctamente se elimina el origen.
    for (const oldKey of sourceKeys) {
      await storage.deleteObject({
        key: oldKey,
      });
    }

    return {
      previousKey: sourceKey,
      key: destinationKey,
      projectKey: normalizeProjectKey(projectKey),
      folderName: validateSegment(
        newFolderName,
        "newFolderName"
      ),
      folderPath: normalizeFolderPath(newParentPath),
    };
  }

  // ----------------------------------------------------
  // DELETE
  // ----------------------------------------------------

  /**
   * Elimina una carpeta.
   *
   * recursive=false:
   * - Solo elimina la carpeta si está vacía.
   *
   * recursive=true:
   * - Elimina los archivos, subcarpetas y marcadores
   *   encontrados bajo su prefijo.
   *
   * La raíz del proyecto no se puede eliminar mediante
   * esta función. Para eso debe existir una operación
   * específica de eliminación de proyecto.
   */
  async function deleteFolder({
    projectKey,
    folderPath = "",
    folderName,
    recursive = false,
  }) {
    const key = buildFolderKey({
      projectKey,
      folderPath,
      folderName,
    });

    const marker = await storage.headObject({ key });

    const objects = await listAllObjects(storage, key);

    if (!marker && objects.length === 0) {
      const error = new Error(
        `No se encontró la carpeta "${key}".`
      );
      error.code = "EFOLDER_NOT_FOUND";
      throw error;
    }

    // No permite borrar una carpeta con contenido
    // accidentalmente cuando recursive está desactivado.
    if (!recursive) {
      const children = objects.filter(
        (object) => object.key !== key
      );

      if (children.length > 0) {
        const error = new Error(
          `La carpeta "${key}" no está vacía.`
        );
        error.code = "EFOLDER_NOT_EMPTY";
        throw error;
      }
    }

    // Elimina los objetos del prefijo cuando se solicitó
    // explícitamente una eliminación recursiva.
    if (recursive) {
      for (const object of objects) {
        if (typeof object.key !== "string") {
          continue;
        }

        await storage.deleteObject({
          key: object.key,
        });
      }
    }

    // Elimina el marcador, si existe.
    if (marker) {
      await storage.deleteObject({ key });
    }

    return {
      deleted: true,
      key,
      recursive,
    };
  }

  // ----------------------------------------------------
  // API PÚBLICA DEL RECURSO
  // ----------------------------------------------------

  return Object.freeze({
    createFolder,
    getFolder,
    listFolders,
    listProjectFolders,
    folderExists,
    renameFolder,
    deleteFolder,
  });
}