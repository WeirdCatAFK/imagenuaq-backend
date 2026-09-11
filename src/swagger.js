// The OpenAPI description of this API, hand-written.
//
// Hand-written rather than generated from JSDoc annotations (`swagger-jsdoc`) for two
// reasons. The annotation form spreads one document across every route file in a YAML
// dialect embedded in comments, where a typo is a silent omission rather than an error --
// and this repository already keeps its route table in one place on purpose (`ROUTERS` in
// src/api.js), for the same reason. A single module is also the only form that can be
// asserted against: tests/docs.test.js reads this object and fails when a mounted router
// has no documented path, which is the drift a generator is usually bought to prevent.
//
// The cost is that this file is updated by hand when a route changes. That is the trade,
// and the test is what keeps it honest.
//
// OpenAPI 3.1 rather than 3.0: it is the version that agrees with JSON Schema, so a
// nullable field is `type: ['integer', 'null']` instead of 3.0's bespoke `nullable: true`.
// swagger-ui-dist 5.x, which swagger-ui-express 5 bundles, renders it.

// Reusable error body. Every refusal in this API comes out of middlewares/errorHandler.js
// in this one shape, including the ones Express's body parser raises before our code runs.
// The `stack` field is present outside production only; it is documented because a client
// developer will see it locally and should know it is not part of the contract.
const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        stack: {
          type: 'string',
          description: 'Present only when NODE_ENV is not "production".',
        },
      },
      required: ['message'],
    },
  },
  required: ['error'],
};

// A refusal, as an inline response object. Written as a helper because every path needs
// three or four of them and the difference between them is one sentence.
const errorResponse = (description, example) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      ...(example ? { example: { error: { message: example } } } : {}),
    },
  },
});

// The same trade as errorResponse(), for the three shapes the areas and roles routes repeat
// two dozen times between them. Written as helpers rather than as more literal objects
// because the difference between any two of those operations is a sentence, and a document
// where the boilerplate outweighs the content stops being read.
const pathId = (name, description) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'integer', minimum: 1 },
  description,
});

const jsonBody = (schema) => ({
  required: true,
  content: {
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});

const jsonResponse = (description, schema) => ({
  description,
  content: {
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});

// Most responses here are a single named key wrapping the record -- `{ area: {...} }`,
// `{ roles: [...] }`. The envelope is deliberate: it leaves room to add a sibling field
// without changing the type of the response body, which is what happened to
// POST /api/users and its `inviteToken`.
const wrapped = (description, key, schema, isArray = false) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          [key]: isArray
            ? { type: 'array', items: { $ref: `#/components/schemas/${schema}` } }
            : { $ref: `#/components/schemas/${schema}` },
        },
        required: [key],
      },
    },
  },
});

const UNAUTHORIZED = { $ref: '#/components/responses/Unauthorized' };
const FORBIDDEN = { $ref: '#/components/responses/Forbidden' };

// The identity a session carries. Deliberately the same five fields the JWT holds and
// verifyToken() returns, because that is what `req.user` means everywhere -- see
// issueToken() in access/orchestration/auth.js. Permissions are not among them: the
// catalog is editable at runtime (RF-USR-05), so they are read per request instead.
const sessionUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 12 },
    email: { type: 'string', format: 'email', example: 'ana.ruiz@uaq.mx' },
    fullName: { type: 'string', example: 'Ana Ruiz' },
    roleId: { type: 'integer', example: 3 },
    role: {
      type: 'string',
      description:
        'roles.name, not an id: ids differ per database, the name is the stable ' +
        'identifier the frontend and requireRole() compare against.',
      example: 'worker',
    },
    areaId: {
      type: ['integer', 'null'],
      description:
        'users.primary_area_id, so a screen knows which area the signed-in user belongs ' +
        'to without spending a request on it. Like `role`, it is a snapshot: nothing ' +
        're-reads the database on a verified token, so it can be up to seven days behind. ' +
        'Good enough to render with, not to authorise or to record history on -- ' +
        '`logs.area_id` is resolved from the database at write time for that reason.',
      example: 2,
    },
  },
  required: ['id', 'email', 'fullName', 'roleId', 'role', 'areaId'],
};

// Builds the document. A function rather than a module-level constant so the server URL is
// read when the API is mounted rather than when this module is first imported -- import
// order is not something a caller should have to reason about to get the right host.
export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Imagen UAQ API',
      version: '0.1.0',
      description: [
        'API interna de la Dirección de Imagen y Comunicación de la UAQ.',
        '',
        'Only the USR half of the system is reachable over HTTP today: authentication,',
        'sessions, staff accounts, areas and roles. SOL, PRY, FLW, TSK, EST, CAL, ARC,',
        'FIN, INV, IMP, RPT and EXT exist in the requirements and, for some, in the',
        'schema, but have no endpoints yet -- their absence here is the state of the work,',
        'not an omission from this document.',
        '',
        '**Authentication.** `POST /api/auth/login` returns a bearer token good for seven',
        'days. Paste it into *Authorize* to exercise the guarded routes below.',
        '',
        '**Accounts are never self-registered** (RF-USR-01, RF-USR-02). An admin creates',
        'one with `POST /api/users`, which returns a single-use `inviteToken`; its owner',
        'redeems it at `POST /api/auth/activate` to choose a password and get a session.',
      ].join('\n'),
    },
    servers: [
      {
        // Relative, and first, on purpose: Swagger UI resolves it against the page it is
        // being served from, so "Try it out" hits the host the reader actually opened --
        // the random port a test binds, localhost in development, the tunnel domain in
        // production -- without this file knowing which of those it is.
        url: '/',
        description: 'This server',
      },
      ...(process.env.API_DOMAIN
        ? [{ url: process.env.API_DOMAIN, description: 'API_DOMAIN from the environment' }]
        : []),
    ],
    tags: [
      {
        name: 'service',
        description: 'Liveness and readiness. No database, or only the database.',
      },
      { name: 'auth', description: 'Sessions, invitations and the identity behind a token.' },
      { name: 'users', description: 'Staff accounts. Coordination only (RF-USR-02).' },
      {
        name: 'areas',
        description:
          'Areas, who is in them, and how they hang off each other. A coordination is not ' +
          'a different record from an area -- it is an area with areas under it ' +
          '(RF-USR-09). Reads are open to any signed-in user (RF-USR-03); writes are ' +
          "coordination's.",
      },
      {
        name: 'contract-types',
        description:
          'The schemes of employment RF-AUS-02 names, read-only. A form creating an ' +
          'account has to name one, and the ids are per-database. Adding a scheme is a ' +
          'migration; how many days each one grants is `contract_type_entitlements` ' +
          '(RF-AUS-04), not this list.',
      },
      {
        name: 'roles',
        description:
          'The role catalogue and the permissions each role grants. `admin` and `finance` ' +
          'arrive with the two grants that are definitions rather than configuration; ' +
          '`worker` and `area_lead` arrive with none, because theirs is a policy decision ' +
          'coordination makes here (RF-USR-05).',
      },
    ],
    components: {
      securitySchemes: {
        // One scheme, for the session token only. The invite token is also a bearer
        // credential but it never travels in this header -- it arrives in a request body
        // -- so describing it here would put it in Authorize, where it does not work.
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'The `token` returned by `POST /api/auth/login` or `POST /api/auth/activate`. ' +
            'HS256, valid seven days -- but the user row is re-read on every request, so ' +
            'a deleted account stops working at once, and role, area and name are always ' +
            'the current ones rather than the ones the token was signed with.',
        },
      },
      schemas: {
        Error: errorSchema,
        SessionUser: sessionUserSchema,
        HealthReport: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            database: {
              type: 'object',
              properties: {
                reachable: { type: 'boolean' },
                latencyMs: {
                  type: 'integer',
                  description: 'Present when reachable.',
                  example: 3,
                },
                error: {
                  type: 'string',
                  description: 'Present when not reachable.',
                  example: 'ECONNREFUSED',
                },
              },
              required: ['reachable'],
            },
            uptime: {
              type: 'number',
              description: 'Seconds since this process started.',
              example: 412.7,
            },
          },
          required: ['status', 'database', 'uptime'],
        },
        CreatedUser: {
          allOf: [
            { $ref: '#/components/schemas/SessionUser' },
            {
              type: 'object',
              properties: {
                primaryAreaId: {
                  type: ['integer', 'null'],
                  description: 'The area the account belongs to, or null (RF-USR-09).',
                  example: 2,
                },
              },
            },
          ],
        },
        LoginRequest: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email', example: 'ana.ruiz@uaq.mx' },
            password: { type: 'string', format: 'password', minLength: 8 },
          },
          required: ['email', 'password'],
        },
        SessionResponse: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'HS256 JWT, valid seven days.' },
            user: { $ref: '#/components/schemas/SessionUser' },
          },
          required: ['token', 'user'],
        },
        ActivateRequest: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description:
                'The `inviteToken` from POST /api/users. Valid only while the account has ' +
                'no password, which is what makes it single-use.',
            },
            password: {
              type: 'string',
              format: 'password',
              minLength: 8,
              description: 'Chosen by the account owner. Stored as bcrypt, cost 12.',
            },
          },
          required: ['token', 'password'],
        },
        CreateUserRequest: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              format: 'email',
              maxLength: 320,
              description:
                'Lower-cased and trimmed on the way in; uniqueness is on the stored form.',
              example: 'ana.ruiz@uaq.mx',
            },
            fullName: { type: 'string', maxLength: 200, example: 'Ana Ruiz' },
            roleId: {
              type: 'integer',
              description:
                'roles.id. One of the three levels in RF-USR-02; the caller may not choose ' +
                'their own, which is why there is no self-registration.',
              example: 3,
            },
            contractTypeId: {
              type: 'integer',
              description:
                'contract_types.id. Required because RF-AUS-04 reads absence caps from it.',
              example: 1,
            },
            primaryAreaId: {
              type: ['integer', 'null'],
              description:
                'areas.id (RF-USR-09). Optional, but required when isAreaLeader is true.',
              example: 2,
            },
            birthday: { type: ['string', 'null'], format: 'date', example: '1994-06-30' },
            isAreaLeader: {
              type: 'boolean',
              default: false,
              description: 'Marks the account as the lead of primaryAreaId (RF-USR-04).',
            },
          },
          required: ['email', 'fullName', 'roleId', 'contractTypeId'],
        },
        CreateUserResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/CreatedUser' },
            inviteToken: {
              type: 'string',
              description:
                'The only moment this exists -- it is not stored and cannot be read back. ' +
                'Alongside the user rather than inside it because it is a credential with ' +
                'a life of its own, not a property of the account.',
            },
          },
          required: ['user', 'inviteToken'],
        },
        InviteResponse: {
          type: 'object',
          properties: { inviteToken: { type: 'string' } },
          required: ['inviteToken'],
        },
        // The two read shapes. RF-USR-03 lets any colleague see who else is in the
        // organisation, so `User` is what every signed-in caller gets; `UserAdmin` adds the
        // fields that are coordination's business and nobody else's.
        UserArea: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 3 },
            name: { type: 'string', example: 'Diseño Gráfico' },
            isAreaLeader: { type: 'boolean', example: false },
          },
          required: ['id', 'name', 'isAreaLeader'],
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 12 },
            fullName: { type: 'string', example: 'Ana Gómez' },
            email: { type: 'string', format: 'email' },
            role: { type: ['string', 'null'], example: 'worker' },
            roleId: { type: 'integer', example: 1 },
            primaryAreaId: { type: ['integer', 'null'], example: 3 },
            areas: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserArea' },
            },
          },
          required: ['id', 'fullName', 'email', 'role', 'roleId', 'primaryAreaId'],
        },
        UserAdmin: {
          allOf: [
            { $ref: '#/components/schemas/User' },
            {
              type: 'object',
              properties: {
                contractTypeId: { type: ['integer', 'null'] },
                birthday: { type: ['string', 'null'], format: 'date' },
                createdAt: { type: 'string', format: 'date-time' },
                deletedAt: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description:
                    'Non-null only when the caller asked for includeDeleted, which is ' +
                    'honoured for an admin and ignored for anybody else.',
                },
              },
            },
          ],
        },
        UserListResponse: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserAdmin' },
            },
            total: {
              type: 'integer',
              description: 'Matching rows before the page window is applied.',
            },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['users', 'total', 'limit', 'offset'],
        },
        UserSearchResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            fullName: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
          required: ['id', 'fullName', 'email'],
        },
        UpdateUserRequest: {
          type: 'object',
          description:
            'Partial: only the keys present are changed, merged against the current row. ' +
            'The role is deliberately absent -- changing what somebody may do belongs with ' +
            'the role catalogue (RF-USR-02), not the profile form.',
          properties: {
            fullName: { type: 'string', maxLength: 200 },
            email: { type: 'string', format: 'email', maxLength: 320 },
            birthday: { type: ['string', 'null'], format: 'date' },
            contractTypeId: { type: 'integer', minimum: 1 },
            primaryAreaId: { type: ['integer', 'null'], minimum: 1 },
            scheduleId: { type: ['integer', 'null'], minimum: 1 },
          },
        },
        Area: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 3 },
            name: { type: 'string', example: 'Diseño Gráfico' },
            description: { type: ['string', 'null'], example: null },
            parentAreaId: {
              type: ['integer', 'null'],
              description:
                'Present on the create response only: the parent the area was written ' +
                'under, or null for a root. The chart carries it on every node.',
            },
          },
          required: ['id', 'name', 'description'],
        },
        CreateAreaRequest: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 200, example: 'Coordinación de Imagen' },
            description: { type: ['string', 'null'] },
            leaderUserId: {
              type: ['integer', 'null'],
              description:
                'Optional. Written in the same statement as the area, so a failure cannot ' +
                'leave an area nobody is responsible for.',
            },
            parentAreaId: {
              type: ['integer', 'null'],
              description:
                'Optional. Omitted: the area hangs under the one DEFAULT_AREA names in ' +
                '.env (or is a root when that is unset or matches nothing). An id: that ' +
                'parent. An explicit null: a root. Written in the same statement as the area.',
            },
          },
          required: ['name'],
        },
        UpdateAreaRequest: {
          type: 'object',
          description:
            'Partial: only the keys present are changed, merged against the current row.',
          properties: {
            name: { type: 'string', maxLength: 200 },
            description: { type: ['string', 'null'] },
          },
        },
        AreaMember: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 12 },
            email: { type: 'string', format: 'email', example: 'ana.ruiz@uaq.mx' },
            fullName: { type: 'string', example: 'Ana Ruiz' },
            role: {
              type: 'string',
              description: 'roles.name, not an id -- see SessionUser.',
              example: 'area_lead',
            },
            isAreaLeader: {
              type: 'boolean',
              description:
                'Leadership lives on area_members, not on areas: somebody can lead one ' +
                'area and be an ordinary member of another.',
            },
          },
          required: ['id', 'email', 'fullName', 'role', 'isAreaLeader'],
        },
        OrgChartNode: {
          type: 'object',
          description:
            'One area and everything under it. Self-referential through `children`, so ' +
            "react-organizational-chart's <Tree>/<TreeNode> recurse over it directly.",
          properties: {
            id: { type: 'integer', example: 3 },
            name: { type: 'string', example: 'Diseño Gráfico' },
            description: { type: ['string', 'null'] },
            parentAreaId: {
              type: ['integer', 'null'],
              description:
                'Null for a root. On the root of a *subtree* request this still carries the ' +
                'parent the area has in the table -- the walk started below it, it is not ' +
                'the top of the organisation.',
            },
            depth: {
              type: 'integer',
              description:
                'Computed by the recursive walk, not stored: depth is a consequence of ' +
                'where the area currently hangs, and a stored copy would go stale on every ' +
                're-parent. Relative to the root of this response.',
              example: 1,
            },
            leaders: {
              type: 'array',
              description:
                'A projection of `members`, not a separate set -- whoever heads the area, ' +
                'for the node label.',
              items: { $ref: '#/components/schemas/AreaMember' },
            },
            members: {
              type: 'array',
              items: { $ref: '#/components/schemas/AreaMember' },
            },
            memberCount: { type: 'integer', example: 7 },
            children: {
              type: 'array',
              items: { $ref: '#/components/schemas/OrgChartNode' },
            },
          },
          required: [
            'id',
            'name',
            'description',
            'parentAreaId',
            'depth',
            'leaders',
            'members',
            'memberCount',
            'children',
          ],
        },
        OrgChart: {
          type: 'object',
          properties: {
            roots: {
              type: 'array',
              description:
                'Every area with no parent. A forest and not a single tree: the ' +
                'organisation has several independent heads, and inventing a synthetic root ' +
                'to join them would put a box in the chart that answers to nobody.',
              items: { $ref: '#/components/schemas/OrgChartNode' },
            },
          },
          required: ['roots'],
        },
        AreaParent: {
          type: 'object',
          properties: {
            areaId: { type: 'integer' },
            parentAreaId: { type: ['integer', 'null'] },
            changed: {
              type: 'boolean',
              description:
                'DELETE only. False when the area was already a root -- still a 200, ' +
                'because the caller asked for it to have no parent and it has none.',
            },
          },
          required: ['areaId', 'parentAreaId'],
        },
        AreaMembership: {
          type: 'object',
          properties: {
            userId: { type: 'integer' },
            areaId: { type: 'integer' },
            isAreaLeader: { type: 'boolean' },
          },
          required: ['userId', 'areaId', 'isAreaLeader'],
        },
        ContractType: {
          type: 'object',
          description:
            'A scheme of employment (RF-AUS-02). The id differs per database -- it comes ' +
            'from a sequence, not from the requirement -- so a client picks by name and ' +
            'sends the id back, never the other way round.',
          properties: {
            id: { type: 'integer', example: 11 },
            name: { type: 'string', maxLength: 200, example: 'Becario' },
          },
          required: ['id', 'name'],
        },
        Role: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 3 },
            name: {
              type: 'string',
              maxLength: 50,
              description:
                'The stable identifier requireRole() compares. A rename takes effect on ' +
                'the holder\'s next request, because verifyToken() reads `role` from the ' +
                'user row rather than from the token.',
              example: 'area_lead',
            },
            description: { type: ['string', 'null'] },
          },
          required: ['id', 'name', 'description'],
        },
        RoleRequest: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 50 },
            description: { type: ['string', 'null'] },
          },
          required: ['name'],
        },
        Permission: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 11 },
            code: {
              type: 'string',
              maxLength: 100,
              pattern: '^[a-z0-9]+(\\.[a-z0-9]+)+$',
              description:
                'Dotted resource.action. `project.read` and `project.write` are two rows ' +
                'and not two levels of one, which is what makes RF-USR-05 expressible.',
              example: 'area.manage',
            },
            label: { type: 'string', maxLength: 200, example: 'Administrar áreas' },
            description: { type: ['string', 'null'] },
          },
          required: ['id', 'code', 'label', 'description'],
        },
        PermissionRequest: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 100, example: 'invoice.write' },
            label: { type: 'string', maxLength: 200, example: 'Editar facturas' },
            description: { type: ['string', 'null'] },
          },
          required: ['code', 'label'],
        },
        SetRolePermissionsRequest: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              description:
                'Permission **codes**, not ids: ids come from a sequence and differ per ' +
                'database, so the same request would grant different things on staging and ' +
                'in production. An empty array revokes everything.',
              items: { type: 'string' },
              example: ['project.read', 'project.write', 'area.manage'],
            },
          },
          required: ['permissions'],
        },
        RolePermissionGrant: {
          type: 'object',
          properties: {
            roleId: { type: 'integer' },
            permissionId: { type: 'integer' },
            granted: {
              type: 'boolean',
              description:
                'False when the role already held it. Still a success -- the caller asked ' +
                'for the grant to exist and it does; the status code is 200 rather than 201.',
            },
          },
          required: ['roleId', 'permissionId', 'granted'],
        },
        RolePermissionRevoke: {
          type: 'object',
          properties: {
            roleId: { type: 'integer' },
            permissionId: { type: 'integer' },
            revoked: { type: 'boolean' },
          },
          required: ['roleId', 'permissionId', 'revoked'],
        },
      },
      responses: {
        Unauthorized: errorResponse(
          'No token, or a token that is malformed, expired or signed by someone else. 401 ' +
            'rather than 403 on purpose: it tells the frontend to log in again.',
          'No token provided.',
        ),
        Forbidden: errorResponse(
          'Authenticated, and still not allowed. Two messages: `Insufficient role for this ' +
            'resource.` from a route gated on the role name (users, roles), and `Missing ' +
            'permission: <code>.` from one gated on a permission the role does not hold ' +
            '(areas writes need `area.manage`).',
          'Insufficient role for this resource.',
        ),
      },
    },
    paths: {
      '/': {
        get: {
          tags: ['service'],
          summary: 'Readiness ping',
          description:
            'Touches no database, so it answers even when Postgres is gone. That is the ' +
            'division of labour with /api/health, which answers whether it is reachable.',
          security: [],
          responses: {
            200: {
              description: 'The process is up.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      status: { type: 'string' },
                    },
                    required: ['name', 'status'],
                  },
                  example: { name: 'imagenuaq-api', status: 'up' },
                },
              },
            },
          },
        },
      },
      '/api/health': {
        get: {
          tags: ['service'],
          summary: 'Database reachability',
          security: [],
          responses: {
            200: {
              description: 'Postgres answered.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthReport' },
                  example: {
                    status: 'ok',
                    database: { reachable: true, latencyMs: 3 },
                    uptime: 412.7,
                  },
                },
              },
            },
            503: {
              description:
                'Postgres did not answer. The body is the same shape as the 200 -- the ' +
                'report is the response, not an error.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthReport' },
                  example: {
                    status: 'degraded',
                    database: { reachable: false, error: 'ECONNREFUSED' },
                    uptime: 412.7,
                  },
                },
              },
            },
          },
        },
      },
      '/api/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Exchange an email and password for a session token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } },
            },
          },
          responses: {
            200: {
              description: 'A seven-day session token and the identity it carries.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            400: errorResponse('A field is missing.', 'Email and password are required.'),
            401: errorResponse(
              'One message for "no such email", "no password set" and "wrong password". ' +
                'Splitting them would tell an attacker which addresses are worth guessing at.',
              'Invalid email or password.',
            ),
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'Who the presented token says you are',
          description:
            'The cheap way for a client to find out whether a stored token is still good. ' +
            'Reads the token only; it does not re-read the account behind it.',
          responses: {
            200: {
              description: 'The subject of the token.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { user: { $ref: '#/components/schemas/SessionUser' } },
                    required: ['user'],
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/auth/activate': {
        post: {
          tags: ['auth'],
          summary: 'Redeem an invitation: choose a password and get a session',
          description:
            'Public by design, and not a hole: the invite token is the credential, it was ' +
            'minted for one specific account by an admin, and it stops working the moment ' +
            'the password is set. Requiring a session here would be circular -- the caller ' +
            'has no way to get one yet.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ActivateRequest' } },
            },
          },
          responses: {
            200: {
              description: 'The account now has a password, and this is its first session.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            400: errorResponse(
              'No token, or a password under eight characters.',
              'Password must be at least 8 characters long.',
            ),
            401: errorResponse(
              'The token is malformed, expired, or a session token rather than an invite ' +
                '-- the `purpose` claim is what keeps the two apart.',
              'Invalid or expired invitation.',
            ),
            409: errorResponse(
              'The account already has a password. Re-activating would be a password reset ' +
                'by another name, and this flow is not one.',
              'This invitation has already been used.',
            ),
          },
        },
      },
      '/api/users': {
        get: {
          tags: ['users'],
          summary: 'List staff',
          description:
            'Any signed-in caller: RF-USR-03 lets everyone see their colleagues. An admin ' +
            'additionally gets contract type, birthday and timestamps, and is the only ' +
            'caller for whom `includeDeleted` is honoured.',
          parameters: [
            {
              name: 'areaId',
              in: 'query',
              schema: { type: 'integer', minimum: 1 },
              description: 'Only members of this area.',
            },
            {
              name: 'roleId',
              in: 'query',
              schema: { type: 'integer', minimum: 1 },
            },
            {
              name: 'includeDeleted',
              in: 'query',
              schema: { type: 'boolean' },
              description: 'Admin only; ignored for anybody else.',
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            200: jsonResponse('A page of staff.', 'UserListResponse'),
            400: errorResponse(
              'A filter is not a positive integer.',
              'areaId must be a positive integer.',
            ),
            401: UNAUTHORIZED,
          },
        },
        post: {
          tags: ['users'],
          summary: 'Create a staff account and mint its invitation',
          description:
            'Admin only. The account is created with **no password**; the `inviteToken` in ' +
            'the response is how its owner sets one. Promotion to admin is deliberately ' +
            'absent from the API -- the first admin, and any lockout, comes from ' +
            '`npm run admin:create`.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateUserRequest' } },
            },
          },
          responses: {
            201: {
              description: 'The account, and the one-time invitation for it.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CreateUserResponse' },
                },
              },
            },
            400: errorResponse(
              'A field is missing or malformed, or names a role, contract type or area that ' +
                'does not exist.',
              'roleId is required.',
            ),
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            409: errorResponse(
              'The address belongs to a live account. A soft-deleted one does not collide ' +
                '-- the unique index is partial.',
              'A user with that email address already exists.',
            ),
          },
        },
      },
      '/api/users/{id}/invite': {
        post: {
          tags: ['users'],
          summary: 'Re-issue an invitation for an account that never activated',
          description:
            'Invites expire in three days and arrive by email or chat, so the first one ' +
            'going astray is ordinary. Without this the only remedy would be deleting and ' +
            'recreating the user, which changes their id and orphans anything already ' +
            'assigned to them.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 1 },
              description: 'users.id',
            },
          ],
          responses: {
            200: {
              description:
                'A fresh invitation. The previous one keeps working until it expires.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InviteResponse' },
                },
              },
            },
            400: errorResponse('The id is not a positive integer.', 'Invalid user id.'),
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            404: errorResponse('No such user.', 'User not found.'),
            409: errorResponse(
              'The account already has a password, so there is nothing to invite it to.',
              'This account is already active.',
            ),
          },
        },
      },
      '/api/users/search': {
        get: {
          tags: ['users'],
          summary: 'Search staff by name or address',
          description:
            'Declared before `/api/users/{id}` so Express does not capture `search` as an ' +
            'id. Returns the narrow shape a picker needs, never the admin one.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              schema: { type: 'string', minLength: 2 },
              description: 'Matched as a substring of the name or the address.',
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            200: wrapped('The matches.', 'users', 'UserSearchResult', true),
            400: errorResponse(
              'The query is shorter than two characters.',
              'Search query must be at least 2 characters.',
            ),
            401: UNAUTHORIZED,
          },
        },
      },
      '/api/users/{id}': {
        get: {
          tags: ['users'],
          summary: 'One staff member',
          parameters: [pathId('id', 'users.id')],
          responses: {
            200: wrapped('The user, wider when the caller is an admin.', 'user', 'UserAdmin'),
            400: errorResponse('The id is not a positive integer.', 'Invalid user id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such user, or it is soft-deleted.', 'User not found.'),
          },
        },
        patch: {
          tags: ['users'],
          summary: 'Edit a staff account',
          description:
            'Admin only. Partial: the current row is read and merged, so omitting a key ' +
            'leaves it alone.',
          parameters: [pathId('id', 'users.id')],
          requestBody: jsonBody('UpdateUserRequest'),
          responses: {
            200: wrapped('The updated user.', 'user', 'UserAdmin'),
            400: errorResponse(
              'A field is malformed, or names a contract type, area or schedule that does ' +
                'not exist.',
              'Unknown contractTypeId.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such user.', 'User not found.'),
            409: errorResponse(
              'The address belongs to another live account.',
              'A user with that email address already exists.',
            ),
          },
        },
        delete: {
          tags: ['users'],
          summary: 'Soft-delete a staff account and revoke its sessions',
          description:
            'Admin only. Sets `deleted_at` and bumps `token_version` in the same ' +
            'statement, so the account stops working immediately rather than when its ' +
            'token expires. The address becomes reusable -- the unique index is partial.',
          parameters: [pathId('id', 'users.id')],
          responses: {
            200: wrapped('The account as it stood when deleted.', 'user', 'UserAdmin'),
            400: errorResponse('The id is not a positive integer.', 'Invalid user id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such user, or it was already deleted.', 'User not found.'),
          },
        },
      },
      '/api/users/{id}/picture': {
        get: {
          tags: ['users'],
          summary: 'A profile picture',
          description: 'Served back as the type it was uploaded with.',
          parameters: [pathId('id', 'users.id')],
          responses: {
            200: {
              description: 'The image bytes.',
              content: {
                'image/png': { schema: { type: 'string', format: 'binary' } },
                'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                'image/webp': { schema: { type: 'string', format: 'binary' } },
              },
            },
            400: errorResponse('The id is not a positive integer.', 'Invalid user id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such user, or no picture set.', 'No profile picture set.'),
          },
        },
        put: {
          tags: ['users'],
          summary: 'Replace a profile picture',
          description:
            'Admin only. The body is the raw image, not multipart -- the framework has its ' +
            'own express.raw() parser, so no upload dependency is needed. Capped at 2 MB.',
          parameters: [pathId('id', 'users.id')],
          requestBody: {
            required: true,
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            204: { description: 'Stored.' },
            400: errorResponse(
              'The body is empty or the type is not one of the three accepted.',
              'Content-Type must be one of: image/png, image/jpeg, image/webp.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such user.', 'User not found.'),
            413: errorResponse('The image is larger than 2 MB.'),
          },
        },
        delete: {
          tags: ['users'],
          summary: 'Remove a profile picture',
          description: 'Admin only. Clears the bytes and the type together.',
          parameters: [pathId('id', 'users.id')],
          responses: {
            204: { description: 'Removed, or there was nothing to remove.' },
            400: errorResponse('The id is not a positive integer.', 'Invalid user id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such user.', 'User not found.'),
          },
        },
      },

      // --- areas ---
      //
      // Reads need only a session (RF-USR-03); writes need the `area.manage` permission,
      // which catalog-bootstrap grants `admin` and PUT /api/roles/{id}/permissions can grant
      // anyone else. The first router on the permission model -- see routes/areas.js.

      '/api/areas': {
        get: {
          tags: ['areas'],
          summary: 'List every area',
          description:
            'Flat and alphabetical. The nesting is a separate read -- see ' +
            '`/api/areas/orgchart` -- because a picker wants the list and a chart wants the ' +
            'tree, and neither should pay for the other.',
          responses: {
            200: wrapped('Every area, by name.', 'areas', 'Area', true),
            401: UNAUTHORIZED,
          },
        },
        post: {
          tags: ['areas'],
          summary: 'Create an area',
          description:
            'Needs area.manage. RF-USR-09: new areas and coordinations without a deploy. ' +
            '`leaderUserId` and `parentAreaId` are written in the same statement as the ' +
            'area. Omit `parentAreaId` to hang it under DEFAULT_AREA; send null for a root.',
          requestBody: jsonBody('CreateAreaRequest'),
          responses: {
            201: wrapped('The created area, with `parentAreaId` as written.', 'area', 'Area'),
            400: errorResponse(
              'The name is missing or too long, leaderUserId names no user, or ' +
                'parentAreaId names no area.',
              'Area name is required (200 characters or fewer).',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            409: errorResponse(
              'The name is taken. `uq_areas_name` is a plain unique index, not a partial ' +
                'one: areas have no deleted_at, because a referenced row cannot be deleted.',
              'An area with that name already exists.',
            ),
          },
        },
      },
      '/api/areas/orgchart': {
        get: {
          tags: ['areas'],
          summary: 'The whole organisation as a forest of nested areas',
          description:
            'Two queries, whatever the size: the tree, then every member of every area in ' +
            'it. Each node carries its own `children`, so the frontend recurses over the ' +
            'response directly.\n\n' +
            'Any signed-in user may read it. RF-USR-03 gives every member of an area ' +
            "unrestricted sight of their colleagues' work, and who is in which area is the " +
            'most basic form of that.',
          responses: {
            200: jsonResponse('Every root area, with its subtree.', 'OrgChart'),
            401: UNAUTHORIZED,
          },
        },
      },
      '/api/areas/{id}': {
        get: {
          tags: ['areas'],
          summary: 'One area',
          parameters: [pathId('id', 'areas.id')],
          responses: {
            200: wrapped('The area.', 'area', 'Area'),
            400: errorResponse('The id is not a positive integer.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such area.', 'Area not found.'),
          },
        },
        patch: {
          tags: ['areas'],
          summary: 'Rename an area or change its description',
          description:
            'Needs area.manage. Partial: keys absent from the body are left as they are.',
          parameters: [pathId('id', 'areas.id')],
          requestBody: jsonBody('UpdateAreaRequest'),
          responses: {
            200: wrapped('The updated area.', 'area', 'Area'),
            400: errorResponse('The id or the name is malformed.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such area.', 'Area not found.'),
            409: errorResponse(
              'Another area already has that name.',
              'An area with that name already exists.',
            ),
          },
        },
        delete: {
          tags: ['areas'],
          summary: 'Delete an area',
          description:
            'Needs area.manage, and a hard delete -- `areas` has no deleted_at. Child areas are ' +
            'promoted to roots of the chart by the cascade on `area_hierarchy`; people are ' +
            'not, so an area with members or with users whose primary area it is cannot be ' +
            'deleted at all.',
          parameters: [pathId('id', 'areas.id')],
          responses: {
            200: wrapped('The deleted area.', 'area', 'Area'),
            400: errorResponse('The id is not a positive integer.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such area.', 'Area not found.'),
            409: errorResponse(
              'Somebody is still assigned to it. The foreign key is the authority here: a ' +
                'count taken first would race a concurrent assignment.',
              'That area still has users or records assigned to it; reassign them first.',
            ),
          },
        },
      },
      '/api/areas/{id}/orgchart': {
        get: {
          tags: ['areas'],
          summary: 'The subtree rooted at one area',
          description:
            'The read RF-USR-04 is written in: an area lead or coordination consults the ' +
            'work of *todos los usuarios a su cargo*, and who that is is exactly this ' +
            'subtree. The area comes back as the single entry in `roots`, so the same ' +
            'component renders it either way.',
          parameters: [pathId('id', 'areas.id -- the root of the subtree')],
          responses: {
            200: jsonResponse('The area and everything under it.', 'OrgChart'),
            400: errorResponse('The id is not a positive integer.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such area.', 'Area not found.'),
          },
        },
      },
      '/api/areas/{id}/members': {
        get: {
          tags: ['areas'],
          summary: "One area's roster",
          description: 'Leaders first, then alphabetical. Soft-deleted users are excluded.',
          parameters: [pathId('id', 'areas.id')],
          responses: {
            200: wrapped('The members of the area.', 'members', 'AreaMember', true),
            400: errorResponse('The id is not a positive integer.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such area.', 'Area not found.'),
          },
        },
      },
      '/api/areas/{id}/parent': {
        put: {
          tags: ['areas'],
          summary: 'Hang this area under another one',
          description:
            'Needs area.manage. PUT and not POST: an area has at most one parent, so this replaces ' +
            'a single value rather than adding one more relation -- the child is the whole ' +
            'primary key of `area_hierarchy`.\n\n' +
            'A move that would close a cycle is refused with 409. The table constrains one ' +
            'hop; A under B under A is checked here, and this endpoint is the only write ' +
            'path that does it.',
          parameters: [pathId('id', 'areas.id -- the area being moved')],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { parentAreaId: { type: 'integer', minimum: 1 } },
                  required: ['parentAreaId'],
                },
              },
            },
          },
          responses: {
            200: jsonResponse('The new parent link.', 'AreaParent'),
            400: errorResponse(
              'A malformed id, or an area named as its own parent.',
              'An area cannot be its own parent.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('Either area is missing.', 'Parent area not found.'),
            409: errorResponse(
              'The proposed parent is already below this area, so the move would close a ' +
                'cycle and the chart would have no root.',
              'That area is already below this one; the move would close a cycle.',
            ),
          },
        },
        delete: {
          tags: ['areas'],
          summary: 'Promote an area back to a root of the chart',
          description:
            'Needs area.manage. Not an error when the area was already a root: `changed` says ' +
            'which of the two happened.',
          parameters: [pathId('id', 'areas.id')],
          responses: {
            200: jsonResponse('The area, now parentless.', 'AreaParent'),
            400: errorResponse('The id is not a positive integer.', 'Invalid area id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such area.', 'Area not found.'),
          },
        },
      },
      '/api/areas/{id}/members/{userId}': {
        put: {
          tags: ['areas'],
          summary: 'Add a user to an area, or change whether they lead it',
          description:
            'Needs area.manage, and one route for both because they are one upsert -- the client ' +
            'should not have to know which of the two it is doing. A user can be in several ' +
            'areas and lead only some of them, which is why leadership lives here rather ' +
            'than on `areas`.',
          parameters: [pathId('id', 'areas.id'), pathId('userId', 'users.id')],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { isAreaLeader: { type: 'boolean', default: false } },
                },
              },
            },
          },
          responses: {
            200: jsonResponse('The membership.', 'AreaMembership'),
            400: errorResponse(
              'A malformed id, or one that names no area or user.',
              'Invalid user id.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
          },
        },
        delete: {
          tags: ['areas'],
          summary: 'Remove a user from an area',
          description:
            'Needs area.manage. This removes the membership, not the account -- and not ' +
            '`users.primary_area_id`, which is a separate column with a separate meaning.',
          parameters: [pathId('id', 'areas.id'), pathId('userId', 'users.id')],
          responses: {
            200: jsonResponse('The membership that was removed.', 'AreaMembership'),
            400: errorResponse('A malformed id.', 'Invalid user id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse(
              'That user was not a member of that area.',
              'That user is not a member of this area.',
            ),
          },
        },
      },

      // --- roles ---
      //
      // The catalogues are readable by anyone signed in; editing them is editing the
      // authorisation model, so it is admin-only. Deliberately NOT requirePermission():
      // the grants these endpoints write are what requirePermission() reads, so gating them
      // on one would make an empty role_permissions unrecoverable over HTTP.

      '/api/contract-types': {
        get: {
          tags: ['contract-types'],
          summary: 'List every contract scheme',
          description:
            'Readable by any signed-in user. `users.contract_type_id` is NOT NULL, so the ' +
            'form that creates an account has to name one of these -- and hard-coding the ' +
            'ids is not an option, because they come from a sequence and differ per ' +
            'database.',
          responses: {
            200: wrapped('Every scheme, by name.', 'contractTypes', 'ContractType', true),
            401: UNAUTHORIZED,
          },
        },
      },
      '/api/roles': {
        get: {
          tags: ['roles'],
          summary: 'List every role',
          description:
            'Readable by any signed-in user: a form that assigns somebody a role has to ' +
            'list the roles, and hiding the list would mean the frontend hard-coding the ' +
            'four names this module exists to make editable.',
          responses: {
            200: wrapped('Every role, by name.', 'roles', 'Role', true),
            401: UNAUTHORIZED,
          },
        },
        post: {
          tags: ['roles'],
          summary: 'Create a role',
          description:
            'Admin only. RF-USR-02 names three levels and the migration seeded four rows; ' +
            'this is how the fifth arrives without a deploy.',
          requestBody: jsonBody('RoleRequest'),
          responses: {
            201: wrapped('The created role.', 'role', 'Role'),
            400: errorResponse(
              'The name is missing or longer than 50 characters.',
              'Role name is required (50 characters or fewer).',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            409: errorResponse(
              'The name is taken.',
              'A role with that name already exists.',
            ),
          },
        },
      },
      '/api/roles/permissions': {
        get: {
          tags: ['roles'],
          summary: 'The permission catalogue',
          description:
            'Every code that exists, whoever holds it. The seeded rows are the ' +
            'requirements made data -- `availability.read` and `absence.reason.read` are two ' +
            'of them precisely so RF-USR-10 cannot be collapsed into one.',
          responses: {
            200: wrapped('Every permission, by code.', 'permissions', 'Permission', true),
            401: UNAUTHORIZED,
          },
        },
        post: {
          tags: ['roles'],
          summary: 'Add a permission to the catalogue',
          description:
            'Admin only. The code must be dotted lowercase: requirePermission() compares ' +
            'these strings literally, so `Project Read` and `project.read` are two ' +
            'permissions that look like one to whoever grants them.',
          requestBody: jsonBody('PermissionRequest'),
          responses: {
            201: wrapped('The created permission.', 'permission', 'Permission'),
            400: errorResponse(
              'The code or label is missing, too long, or not dotted lowercase.',
              'Permission code must be dotted lowercase, e.g. project.write.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            409: errorResponse(
              'The code is taken.',
              'A permission with that code already exists.',
            ),
          },
        },
      },
      '/api/roles/permissions/{permissionId}': {
        patch: {
          tags: ['roles'],
          summary: 'Edit a permission in the catalogue',
          description:
            'Admin only. Changing a `code` changes what every requirePermission() call in ' +
            'the source is comparing against, and nothing in the database knows about those ' +
            'call sites -- prefer adding a row to renaming one.',
          parameters: [pathId('permissionId', 'permissions.id')],
          requestBody: jsonBody('PermissionRequest'),
          responses: {
            200: wrapped('The updated permission.', 'permission', 'Permission'),
            400: errorResponse('A malformed id, code or label.', 'Invalid permission id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such permission.', 'Permission not found.'),
            409: errorResponse(
              'Another permission already has that code.',
              'A permission with that code already exists.',
            ),
          },
        },
        delete: {
          tags: ['roles'],
          summary: 'Remove a permission from the catalogue',
          description:
            'Admin only. Every grant of it is revoked by the cascade on `role_permissions`. ' +
            'Survivable in a way deleting a role is not: requirePermission() fails closed ' +
            'on a code nobody holds, so the worst outcome is a route that refuses everyone, ' +
            'which is visible immediately.',
          parameters: [pathId('permissionId', 'permissions.id')],
          responses: {
            200: wrapped('The deleted permission.', 'permission', 'Permission'),
            400: errorResponse('The id is not a positive integer.', 'Invalid permission id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such permission.', 'Permission not found.'),
          },
        },
      },
      '/api/roles/{id}': {
        get: {
          tags: ['roles'],
          summary: 'One role',
          parameters: [pathId('id', 'roles.id')],
          responses: {
            200: wrapped('The role.', 'role', 'Role'),
            400: errorResponse('The id is not a positive integer.', 'Invalid role id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such role.', 'Role not found.'),
          },
        },
        patch: {
          tags: ['roles'],
          summary: 'Rename a role or change its description',
          description:
            'Admin only, and renaming is heavier than it looks: requireRole() compares ' +
            '`roles.name`, and every token already issued carries the OLD name for up to ' +
            'seven days. A rename locks those holders out until they log in again.',
          parameters: [pathId('id', 'roles.id')],
          requestBody: jsonBody('RoleRequest'),
          responses: {
            200: wrapped('The updated role.', 'role', 'Role'),
            400: errorResponse('A malformed id or name.', 'Invalid role id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such role.', 'Role not found.'),
            409: errorResponse(
              'Another role already has that name.',
              'A role with that name already exists.',
            ),
          },
        },
        delete: {
          tags: ['roles'],
          summary: 'Delete a role',
          description:
            'Admin only, and refused while anyone still holds it. Its users are not ' +
            'reassigned automatically and cannot be: `users.role_id` is NOT NULL and there ' +
            'is no defensible default, so choosing one would silently grant or revoke ' +
            "access on somebody else's behalf.",
          parameters: [pathId('id', 'roles.id')],
          responses: {
            200: wrapped('The deleted role.', 'role', 'Role'),
            400: errorResponse('The id is not a positive integer.', 'Invalid role id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such role.', 'Role not found.'),
            409: errorResponse(
              'Live users still hold it. The count is in the message, because a bare 409 ' +
                'leaves the admin guessing how much reassigning there is to do.',
              'That role is still held by 3 users; reassign them first.',
            ),
          },
        },
      },
      '/api/roles/{id}/permissions': {
        get: {
          tags: ['roles'],
          summary: 'What one role may do',
          description:
            'Readable by any signed-in user on purpose. RF-USR-05 makes read and write ' +
            'independent permissions, and a user who cannot see why they were refused ' +
            'something has no way to ask for the right thing.',
          parameters: [pathId('id', 'roles.id')],
          responses: {
            200: wrapped(
              "The role's grants, by code.",
              'permissions',
              'Permission',
              true,
            ),
            400: errorResponse('The id is not a positive integer.', 'Invalid role id.'),
            401: UNAUTHORIZED,
            404: errorResponse('No such role.', 'Role not found.'),
          },
        },
        put: {
          tags: ['roles'],
          summary: "Replace a role's whole grant set",
          description:
            'Admin only. **This is where a role stops being a name and starts meaning ' +
            'something.** `worker` and `area_lead` are seeded with no grants at all, ' +
            "because which of them may do what is coordination's decision and not a " +
            "developer's (RF-USR-05). `admin` arrives with everything, so the model is " +
            'administrable from the first login rather than deadlocked.\n\n' +
            'One statement, not a delete followed by an insert: between those two the role ' +
            'holds nothing, and a request landing in that window is refused for a reason ' +
            'that has nothing to do with it.',
          parameters: [pathId('id', 'roles.id')],
          requestBody: jsonBody('SetRolePermissionsRequest'),
          responses: {
            200: wrapped('The grants the role now holds.', 'permissions', 'Permission', true),
            400: errorResponse(
              'Not an array, or one entry names no permission. The message says which code.',
              'Unknown permission code: project.delete.',
            ),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such role.', 'Role not found.'),
          },
        },
      },
      '/api/roles/{id}/permissions/{permissionId}': {
        post: {
          tags: ['roles'],
          summary: 'Grant one permission to a role',
          description:
            'Admin only. 201 when the grant is new, 200 when the role already held it -- ' +
            'both successes, distinguished for a UI that reports what it actually changed.',
          parameters: [pathId('id', 'roles.id'), pathId('permissionId', 'permissions.id')],
          responses: {
            200: jsonResponse('The role already held it.', 'RolePermissionGrant'),
            201: jsonResponse('The grant was created.', 'RolePermissionGrant'),
            400: errorResponse('A malformed id.', 'Invalid permission id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse('No such role or permission.', 'Permission not found.'),
          },
        },
        delete: {
          tags: ['roles'],
          summary: 'Revoke one permission from a role',
          description:
            'Admin only. Takes effect on the next request, not on the next login: ' +
            'requirePermission() reads `role_permissions` per request precisely so a ' +
            'week-long token cannot keep granting something coordination has revoked.',
          parameters: [pathId('id', 'roles.id'), pathId('permissionId', 'permissions.id')],
          responses: {
            200: jsonResponse('The grant that was removed.', 'RolePermissionRevoke'),
            400: errorResponse('A malformed id.', 'Invalid permission id.'),
            401: UNAUTHORIZED,
            403: FORBIDDEN,
            404: errorResponse(
              'The role did not hold that permission.',
              'That role does not hold that permission.',
            ),
          },
        },
      },
    },
    // Applied to every operation that does not override it. The public ones say
    // `security: []` explicitly rather than relying on this being absent, so a route added
    // later without a thought about auth is documented as locked rather than as open.
    security: [{ bearerAuth: [] }],
  };
}

export default buildOpenApiDocument;
