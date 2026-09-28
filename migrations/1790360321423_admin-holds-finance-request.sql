-- `admin` se quedó sin `finance.request`, que es la clase de hueco que bloquea a quien
-- administra.
--
-- `catalog-bootstrap` §8 concede a `admin` **todo** el catálogo, y la razón está escrita ahí: un
-- administrador que no puede administrar el modelo de autorización es un bloqueo del que solo se
-- sale corriendo `scripts/createAdmin.js` a mano. `stage-io-and-finance` creó el permiso
-- `finance.request` y lo concedió a `finance` —que es a quien le sirve— pero no volvió a pasar
-- por `admin`, así que desde esa migración `admin` tiene 15 de 16 permisos. Lo encontró
-- `roles.test.js::admin arrives holding every permission`, que compara el catálogo contra lo que
-- el rol trae y para eso existe.
--
-- No se edita `stage-io-and-finance`: ya está aplicada y publicada, y una migración aplicada no
-- se reescribe. Esta la corrige hacia adelante.
--
-- **Lo que esto no arregla:** la próxima migración que agregue un permiso puede volver a
-- olvidarlo. Se consideró un disparador sobre `permissions` que concediera cada alta a `admin`
-- solo, y se descartó: dejaría de ser legible quién concedió qué —`role_permissions` es lo que
-- lee `requirePermission()` y lo que audita `RF-USR-07`— y convertiría una política en magia de
-- base de datos. La red que sí queda es la prueba, que falla nombrando la diferencia; y
-- `scripts/createAdmin.js`, que reconcede el catálogo completo en cada corrida (por eso una
-- instalación que lo haya corrido después de `stage-io-and-finance` no tiene este hueco, y por
-- eso el `ON CONFLICT` de abajo no es decorativo).

-- Up Migration

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'finance.request'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration

-- Revierte exactamente esta concesión y ninguna otra: si `createAdmin.js` la volvió a escribir
-- después, este rollback la quita igual, que es lo que significa deshacer esta migración.
DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'admin')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'finance.request');
