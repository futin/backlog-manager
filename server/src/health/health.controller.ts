import { Controller, Get } from '@nestjs/common';

// Fixed once per process, at module load. tick.mjs stores this stamp in its lock and compares it BY IDENTITY at `record` time to prove the server
// restarted under a tick — identity rather than "newer than the lock's start", because the container's clock and the host's drift.
const BOOTED_AT = new Date().toISOString();

@Controller('api/health')
export class HealthController {
  @Get()
  check(): { ok: true; bootedAt: string } {
    return { ok: true, bootedAt: BOOTED_AT };
  }
}
