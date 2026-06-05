import { HTTPException } from "hono/http-exception";

export class UserNotFound extends HTTPException {
  constructor() {
    super(404, {
      message: "User not found",
    });
  }
}

export class JaredIdNotProvided extends HTTPException {
  constructor() {
    super(404, {
      message: "Jared ID not provided",
    });
  }
}

export class JaredNotFound extends HTTPException {
  constructor() {
    super(404, {
      message: "Jared not found",
    });
  }
}

export class JaredNotActive extends HTTPException {
  constructor() {
    super(400, {
      message: "Jared is not active",
    });
  }
}

export class ProjectIdNotProvided extends HTTPException {
  constructor() {
    super(500, {
      message: "Project ID not provided",
    });
  }
}

export class ProjectNotFound extends HTTPException {
  constructor() {
    super(404, {
      message: "Project not found",
    });
  }
}

export class QuestIdNotProvided extends HTTPException {
  constructor() {
    super(400, {
      message: "Quest ID not provided",
    });
  }
}

export class RateLimitError extends HTTPException {
  constructor(message = "Too many requests") {
    super(429, {
      message,
    });
  }
}
