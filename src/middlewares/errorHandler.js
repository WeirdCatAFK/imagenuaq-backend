import { ApiError } from '../utils/ApiError.js';

const isProd = () => process.env.NODE_ENV === 'production';

// Express identifies error middleware by arity, so `next` must stay declared. An
// ApiError is a refusal the caller earned; anything else is a bug, logged in full and
// reported as a 500 whose message is withheld in production.
export const errorHandler = (err, _req, res, _next) => {
  const known = err instanceof ApiError;

  if (!known) console.error(err);

  res.status(known ? err.statusCode : 500).json({
    error: {
      message: known || !isProd() ? err.message : 'Internal server error',
      ...(isProd() ? {} : { stack: err.stack }),
    },
  });
};
