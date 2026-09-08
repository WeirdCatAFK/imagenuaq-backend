import { ApiError } from '../utils/ApiError.js';

const isProd = () => process.env.NODE_ENV === 'production';

// Errors raised by express.json() before any of our code runs: malformed JSON, a body over
// the size limit, an encoding we cannot read. They are not ApiErrors and never will be --
// body-parser has no idea this module exists -- but they are not bugs either, and the rule
// below would otherwise report a caller's stray comma as a 500.
//
// That matters more than it looks. A 500 tells the frontend the server broke and the
// request is worth retrying; both halves are wrong here, and the retry can never succeed.
//
// The gate is `expose`, which is body-parser's own statement that the message describes
// what the client did wrong and is safe to return -- so it is also what makes returning
// the message in production correct rather than a leak. `status` and `type` are required
// alongside it so that an unrelated library setting a stray `expose` cannot smuggle an
// arbitrary error through this branch.
const isBodyParserRefusal = (err) =>
  err?.expose === true &&
  typeof err.type === 'string' &&
  Number.isInteger(err.status) &&
  err.status >= 400 &&
  err.status < 500;

// Express identifies error middleware by arity, so `next` must stay declared. An
// ApiError is a refusal the caller earned; anything else is a bug, logged in full and
// reported as a 500 whose message is withheld in production.
export const errorHandler = (err, _req, res, _next) => {
  const known = err instanceof ApiError;
  const refused = !known && isBodyParserRefusal(err);

  if (!known && !refused) console.error(err);

  const statusCode = known ? err.statusCode : refused ? err.status : 500;
  const showMessage = known || refused || !isProd();

  res.status(statusCode).json({
    error: {
      message: showMessage ? err.message : 'Internal server error',
      ...(isProd() ? {} : { stack: err.stack }),
    },
  });
};
