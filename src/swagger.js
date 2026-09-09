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
  },
  required: ['id', 'email', 'fullName', 'roleId', 'role'],
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
        'sessions and staff accounts. SOL, PRY, FLW, TSK, EST, CAL, ARC, FIN, INV, IMP,',
        'RPT and EXT exist in the requirements and, for some, in the schema, but have no',
        'endpoints yet -- their absence here is the state of the work, not an omission',
        'from this document.',
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
            'HS256, valid seven days. Nothing re-reads the database on a verified token, ' +
            'so a revoked account stays valid until it expires.',
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
      },
      responses: {
        Unauthorized: errorResponse(
          'No token, or a token that is malformed, expired or signed by someone else. 401 ' +
            'rather than 403 on purpose: it tells the frontend to log in again.',
          'No token provided.',
        ),
        Forbidden: errorResponse(
          'Authenticated, and still not allowed. Area leads direct the work of their area ' +
            '(RF-USR-04) but staffing it is not theirs to decide.',
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
    },
    // Applied to every operation that does not override it. The public ones say
    // `security: []` explicitly rather than relying on this being absent, so a route added
    // later without a thought about auth is documented as locked rather than as open.
    security: [{ bearerAuth: [] }],
  };
}

export default buildOpenApiDocument;
