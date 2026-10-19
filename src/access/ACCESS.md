# Access

Se utiliza un patrón de repositorio con nombres propios para el acceso a los datos. La idea es
hacer el desarrollo modular y poder identificar errores según la capa en la que aparecen. Hay
tres capas, y un módulo solo importa de las capas debajo de la suya:

```
access
  orchestration/   Tier 3   reglas de negocio; compone recursos; limpia si algo falla
  resources/       Tier 2   query.js (el ÚNICO módulo que escribe SQL), spreadsheets.js (Graph)
  primitives/      Tier 1   database.js (pool), minioStorage.js (bucket), microsoftGraph.js
```

Los primitivos son el puente hacia un servicio en específico: contienen la lógica de conexión, y
sus errores son errores de conexión.

Los recursos son las tareas que consumen los primitivos. Están en este nivel para identificar
errores en la lógica de interacción con ellos. Un recurso puede usar varios primitivos.

La orquestación son tareas concretas, acciones definidas que normalmente coinciden con cómo se
monta la API. Consumen varios recursos; sus errores indican que falló el conjunto de la tarea, y
controlan las fallas cuando hay varios recursos de por medio, para que el fallo de uno no deje
residuos en otro.

Por eso el límite entre capas es también un límite de clasificación de errores, y nada importa
hacia arriba: un primitivo no conoce recursos, y una ruta llama a la orquestación, nunca a
`query.js`.
