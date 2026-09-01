# Access

Se utiliza un patron de repositorio con nombres personalizados para el acceso a los datos la idea es hacer el desarrollo modular y poder identificar errores seg[un la capa en la que aparecen, hay 3 capas de acceso a los datos

access
  orchestration/   Tier 3
  resources/       Tier 2
  primitives/      Tier 1    database

Los primitivos utilizan como puente para llamar a un recurso en específico, contienen la lógica de conexión y sus manejadores de errores regresan errores de conexión

Los recursos son las tareas para consumir los primitivos que tienene en la conexión, se tienen en este nivel para identificar errores en la lógica de interacción con los primitivos. Los recursos pueden usar multiples primitivos

La orquestración son tareas concretas. Conceptos abstractos de acciones definidas, normalmente coinciden con como se monta la api, estos manejan tareas que consumen múltiples recursos y sus manejadores de errores indican fallos en el conjunto de tareas, también manejan control de fallas si se manejan multiples recursos para que el fallo en uno no deje residuales en otra parte de los recursos
