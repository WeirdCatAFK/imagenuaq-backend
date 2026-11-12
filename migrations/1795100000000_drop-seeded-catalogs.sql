-- Up Migration

-- Migrations build the schema; areas (RF-USR-09), contract types (RF-AUS-02) and request
-- formats (RF-SOL-01) are coordination's data and are entered from the app. Earlier
-- migrations seeded some of each; those seeds are gone from them, and this removes the rows
-- they left on databases that already ran them.
--
-- Only rows nothing uses yet are removed. A seeded row that already carries people,
-- requests, grants or history is real data now, and it stays.

-- Request formats: a seeded format goes only while every version of it is still the seed
-- (no published_by) and no request, project or sheet points at one.
DELETE FROM schema_versions v
 USING schemas s
 WHERE v.schema_id = s.id
   AND s.code IN ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia')
   AND NOT EXISTS (
       SELECT 1 FROM schema_versions sv
        WHERE sv.schema_id = s.id
          AND (sv.published_by IS NOT NULL
               OR EXISTS (SELECT 1 FROM requests r WHERE r.schema_version_id = sv.id)
               OR EXISTS (SELECT 1 FROM projects p WHERE p.schema_version_id = sv.id)
               OR EXISTS (SELECT 1 FROM sheets sh WHERE sh.schema_version_id = sv.id)));

DELETE FROM schemas s
 WHERE s.code IN ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia')
   AND NOT EXISTS (SELECT 1 FROM schema_versions v WHERE v.schema_id = s.id);

DELETE FROM contract_types ct
 WHERE ct.name IN ('Honorarios', 'Eventual', 'Base de confianza', 'Base sindicalizada', 'Becario')
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.contract_type_id = ct.id)
   AND NOT EXISTS (SELECT 1 FROM contract_type_entitlements cte WHERE cte.contract_type_id = ct.id);

-- Areas. area_hierarchy and folder_areas cascade, so a folder grant counts as use here, and
-- an area with any child stays so no child is cut loose. The same DELETE runs twice: the
-- first pass takes the unused leaves, which leaves Coordinación childless for the second.
DELETE FROM areas a
 WHERE a.name IN ('Coordinación', 'Secretaría Particular', 'Producción Audiovisual',
                  'Diseño Gráfico', 'Diseño Web', 'Administración', 'Imprenta', 'Impresión')
   AND NOT EXISTS (SELECT 1 FROM area_hierarchy h WHERE h.parent_area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.primary_area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM area_members am WHERE am.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM folder_areas fa WHERE fa.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM event_participants ep WHERE ep.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM flow_stages fs WHERE fs.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM statuses st WHERE st.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.area_id = a.id);

DELETE FROM areas a
 WHERE a.name IN ('Coordinación', 'Secretaría Particular', 'Producción Audiovisual',
                  'Diseño Gráfico', 'Diseño Web', 'Administración', 'Imprenta', 'Impresión')
   AND NOT EXISTS (SELECT 1 FROM area_hierarchy h WHERE h.parent_area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.primary_area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM area_members am WHERE am.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM folder_areas fa WHERE fa.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM event_participants ep WHERE ep.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM flow_stages fs WHERE fs.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM statuses st WHERE st.area_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.area_id = a.id);


-- Down Migration

-- Nothing to restore: the point of the Up is that these rows are not the migrations' to write.
