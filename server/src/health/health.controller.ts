import { Controller, Get } from '@nestjs/common';

@Controller('api/health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }
}
