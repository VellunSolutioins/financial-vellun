import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  healthCheck(): { status: string } {
    return { status: 'ok' };
  }
}
