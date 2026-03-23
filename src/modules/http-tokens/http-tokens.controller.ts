import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  HttpTokensService,
  UpsertHttpTokenInput,
} from './http-tokens.service';

@Controller('http-tokens')
export class HttpTokensController {
  constructor(private readonly httpTokensService: HttpTokensService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any) {
    await this.httpTokensService.assertOwner(req.user.uid);
    const rows = await this.httpTokensService.list();
    return rows.map((x) => this.httpTokensService.toPublicRecord(x));
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getById(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.httpTokensService.assertOwner(req.user.uid);
    const row = await this.httpTokensService.getById(id);
    return this.httpTokensService.toPublicRecord(row);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async upsert(@Req() req: any, @Body() body: UpsertHttpTokenInput) {
    await this.httpTokensService.assertOwner(req.user.uid);
    const row = await this.httpTokensService.upsert(body, req.user.uid);
    return this.httpTokensService.toPublicRecord(row);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.httpTokensService.assertOwner(req.user.uid);
    await this.httpTokensService.deleteById(id);
    return { success: true };
  }
}
