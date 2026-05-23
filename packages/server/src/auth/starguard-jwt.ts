import { jwtVerify, type JWTPayload } from "jose"
import type { Logger } from "../logger"

export interface StarGuardPayload extends JWTPayload {
  userId: string
  walletAddress: string
  role: string
  email?: string
}

export class StarGuardJwtHandler {
  private readonly secret: Uint8Array | null

  constructor(authSecret: string | undefined, private readonly logger: Logger) {
    if (authSecret) {
      this.secret = new TextEncoder().encode(authSecret)
    } else {
      this.secret = null
    }
  }

  isEnabled(): boolean {
    return this.secret !== null
  }

  async verify(token: string): Promise<StarGuardPayload | null> {
    if (!this.secret) return null
    try {
      const { payload } = await jwtVerify(token, this.secret)
      return payload as StarGuardPayload
    } catch {
      return null
    }
  }
}
