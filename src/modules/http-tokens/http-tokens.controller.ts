import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CreateMyHttpTokenInput,
  HttpTokensService,
  UpdateMyHttpTokenInput,
  UpsertHttpTokenInput,
} from './http-tokens.service';

@Controller('http-tokens')
export class HttpTokensController {
  constructor(private readonly httpTokensService: HttpTokensService) {}

  @Get('my')
  @UseGuards(JwtAuthGuard)
  async listMy(@Req() req: any) {
    const rows = await this.httpTokensService.listByUser(req.user.uid);
    return rows.map((x) => this.httpTokensService.toPublicWebsiteRecord(x));
  }

  @Get('my/:id')
  @UseGuards(JwtAuthGuard)
  async getMyById(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const row = await this.httpTokensService.getByIdForUser(id, req.user.uid);
    return this.httpTokensService.toPublicWebsiteRecord(row);
  }

  @Post('my')
  @UseGuards(JwtAuthGuard)
  async createMy(@Req() req: any, @Body() body: CreateMyHttpTokenInput) {
    const row = await this.httpTokensService.createForUser(body, req.user.uid);
    return this.httpTokensService.toPublicWebsiteRecord(row);
  }

  @Patch('my/:id')
  @UseGuards(JwtAuthGuard)
  async updateMy(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateMyHttpTokenInput,
  ) {
    const row = await this.httpTokensService.updateForUser(id, req.user.uid, body);
    return this.httpTokensService.toPublicWebsiteRecord(row);
  }

  @Delete('my/:id')
  @UseGuards(JwtAuthGuard)
  async removeMy(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.httpTokensService.deleteByIdForUser(id, req.user.uid);
    return { success: true };
  }

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
