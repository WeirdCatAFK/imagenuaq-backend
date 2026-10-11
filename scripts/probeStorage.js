// Exercises the whole folder and file CRUD of the MinIO store against a throwaway project
// and prints what came back at every step.
// Usage: npm run storage:probe
//
// Why this exists as a script and not a test.
//
// It needs a live MinIO and real credentials, so it cannot run in `npm test`, which is
// offline and deterministic by design. It is the same kind of tool as probeSheet.js: the
// questions it answers -- does the bucket layout work, does a rename keep the bytes -- are
// about the real service, not about our code paths.

import { createMinioStorage } from "../src/storage/minioStorage.js";
import { createFilesResource } from "../src/access/resources/file.js";
import { createFoldersResource } from "../src/access/resources/folders.js";

const storage = createMinioStorage();
const files = createFilesResource(storage);
const folders = createFoldersResource(storage);

const projectKey = "TEST-CRUD-0001";

/**
 * Prints a step heading and, when given one, dumps the value it returned.
 *
 * @param {string} title Name of the step.
 * @param {unknown} [data] Value to dump under the heading.
 */
function print(title, data = null) {
  console.log(`\n=== ${title} ===`);

  if (data !== null) {
    console.dir(data, { depth: null });
  }
}

try {

  print("1. CREANDO CARPETAS");

  await folders.createFolder({
    projectKey,
    folderName: "Diseño",
  });

  await folders.createFolder({
    projectKey,
    folderName: "Propuestas",
    folderPath: "Diseño",
  });

  await folders.createFolder({
    projectKey,
    folderName: "Producción",
  });

  console.log("Carpetas creadas correctamente.");

  print("2. CREANDO ARCHIVOS");

  await files.createFile({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
    body: Buffer.from("Primera versión de la propuesta."),
    contentType: "text/plain",
  });

  await files.createFile({
    projectKey,
    folderPath: "Diseño/Propuestas",
    fileName: "logo.txt",
    body: Buffer.from("Archivo del logo."),
    contentType: "text/plain",
  });

  await files.createFile({
    projectKey,
    folderPath: "Producción",
    fileName: "impresion.txt",
    body: Buffer.from("Archivo de producción."),
    contentType: "text/plain",
  });

  console.log("Archivos creados correctamente.");

  print("3. LEYENDO ARCHIVO");

  const file = await files.getFile({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
  });

  console.log("Contenido:");
  console.log(file.body.toString());

  console.log("Metadata:");
  console.dir(file.metadata, { depth: null });

  print("4. VERIFICANDO EXISTENCIA");

  const exists = await files.fileExists({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
  });

  console.log("¿Existe propuesta.txt?", exists);

  print("5. LISTANDO ARCHIVOS DE DISEÑO");

  const designFiles = await files.listFiles({
    projectKey,
    folderPath: "Diseño",
  });

  console.dir(designFiles, { depth: null });

  print("6. LISTANDO TODOS LOS ARCHIVOS DEL PROYECTO");

  const projectFiles = await files.listProjectFiles({
    projectKey,
  });

  console.dir(projectFiles, { depth: null });

  print("7. LISTANDO CARPETAS");

  const projectFolders = await folders.listProjectFolders({
    projectKey,
  });

  console.dir(projectFolders, { depth: null });

  print("8. ACTUALIZANDO ARCHIVO");

  await files.updateFile({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
    body: Buffer.from("SEGUNDA VERSIÓN DE LA PROPUESTA."),
    contentType: "text/plain",
  });

  const updatedFile = await files.getFile({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
  });

  console.log("Nuevo contenido:");
  console.log(updatedFile.body.toString());

  print("9. RENOMBRANDO ARCHIVO");

  await files.renameFile({
    projectKey,
    folderPath: "Diseño",
    fileName: "propuesta.txt",
    newFileName: "propuesta-final.txt",
  });

  console.log("Archivo renombrado correctamente.");

  print("10. RENOMBRANDO CARPETA");

  await folders.renameFolder({
    projectKey,
    folderName: "Producción",
    newFolderName: "Entrega",
  });

  console.log("Carpeta renombrada correctamente.");

  print("11. ESTADO FINAL DEL PROYECTO");

  const finalFiles = await files.listProjectFiles({
    projectKey,
  });

  const finalFolders = await folders.listProjectFolders({
    projectKey,
  });

  console.log("Archivos:");
  console.dir(finalFiles, { depth: null });

  console.log("\nCarpetas:");
  console.dir(finalFolders, { depth: null });

  print("12. LIMPIANDO PROYECTO DE PRUEBA");

  await folders.deleteFolder({
    projectKey,
    folderName: "Diseño",
    recursive: true,
  });

  await folders.deleteFolder({
    projectKey,
    folderName: "Entrega",
    recursive: true,
  });

  console.log("Proyecto de prueba eliminado.");

  print("13. VERIFICANDO LIMPIEZA");

  const remainingFiles = await files.listProjectFiles({
    projectKey,
  });

  const remainingFolders = await folders.listProjectFolders({
    projectKey,
  });

  console.log("Archivos restantes:");
  console.dir(remainingFiles, { depth: null });

  console.log("Carpetas restantes:");
  console.dir(remainingFolders, { depth: null });

  console.log("\n========================================");
  console.log("PRUEBA CRUD COMPLETADA CORRECTAMENTE");
  console.log("========================================");

} catch (error) {
  console.error("\n========================================");
  console.error("ERROR EN LA PRUEBA");
  console.error("========================================");

  console.error(error);

  process.exitCode = 1;
}