import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: '/webchat',
  cors: { origin: '*' },
})
@Injectable()
export class WebChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebChatGateway.name);
  private readonly connectedUsers = new Map<
    string,
    { userId: number; identifier: string }
  >();

  @WebSocketServer()
  server: Server;

  private gatewayService: any;

  constructor(private readonly jwtService: JwtService) {}

  setGatewayService(service: any) {
    this.gatewayService = service;
  }

  afterInit(server: Server) {
    this.logger.log('WebChat gateway initialized (same port as HTTP)');
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.query?.token as string);

      if (!token) {
        throw new WsException('No auth token provided');
      }

      const payload = this.jwtService.verify(token);
      const userId = payload.uid || payload.sub;
      const identifier = payload.identifier || payload.username;

      this.connectedUsers.set(client.id, { userId, identifier });
      client.join(`user:${userId}`);

      this.logger.log(`Client connected: ${client.id} (user: ${identifier})`);
      client.emit('connected', { userId, identifier });
    } catch (error) {
      this.logger.warn(`Client rejected: ${client.id} — ${error.message}`);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userInfo = this.connectedUsers.get(client.id);
    this.connectedUsers.delete(client.id);
    this.logger.debug(
      `Client disconnected: ${client.id} (user: ${userInfo?.identifier || 'unknown'})`,
    );
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      content: string;
      model?: string;
      /** URL công khai tới ảnh/file (nếu có) */
      mediaUrl?: string;
      /** Đường dẫn file trên server mà backend đã lưu sẵn (nâng cao) */
      mediaPath?: string;
      /** Nhiều file đã lưu trên server (cùng một lượt) */
      mediaPaths?: string[];
    },
  ) {
    const userInfo = this.connectedUsers.get(client.id);
    if (!userInfo) {
      return { event: 'error', data: { message: 'Not authenticated' } };
    }

    if (!this.gatewayService) {
      return { event: 'error', data: { message: 'Gateway not ready' } };
    }

    client.emit('message:processing', { status: 'processing' });

    try {
      const result = await this.gatewayService.handleMessage(
        userInfo.userId,
        payload.content,
        {
          channelId: 'webchat',
          model: payload.model,
          mediaUrl: payload.mediaUrl,
          mediaPath: payload.mediaPath,
          mediaPaths: payload.mediaPaths,
        },
      );

      client.emit('message:response', {
        content: result.response,
        threadId: result.threadId,
        tokensUsed: result.tokensUsed,
        runId: result.runId,
      });

      return { event: 'message:ack', data: { success: true } };
    } catch (error) {
      this.logger.error(`WebSocket message failed: ${error.message}`);
      client.emit('message:error', { error: error.message });
      return { event: 'message:ack', data: { success: false } };
    }
  }

  @SubscribeMessage('reset')
  async handleReset(@ConnectedSocket() client: Socket) {
    const userInfo = this.connectedUsers.get(client.id);
    if (!userInfo || !this.gatewayService) {
      return { event: 'error', data: { message: 'Not ready' } };
    }

    const result = await this.gatewayService.resetThread(userInfo.userId);
    client.emit('thread:reset', result);
    return { event: 'reset:ack', data: result };
  }

  emitToUser(userId: number, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }
}
