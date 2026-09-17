// HTTP errors as a type, so any layer can refuse a request without knowing about `res`.
export class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }

  static badRequest(message = 'Bad request') {
    return new ApiError(400, message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }

  static conflict(message = 'Conflict') {
    return new ApiError(409, message);
  }

  // For a refusal that is not ours: an upstream service (Microsoft Graph) failed or throttled
  // the call. 502 rather than 500 so the client can tell "retry later" from "report a bug".
  static badGateway(message = 'Bad gateway') {
    return new ApiError(502, message);
  }
}
