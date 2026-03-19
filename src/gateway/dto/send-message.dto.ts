export class SendMessageDto {
  content: string;
  channelId?: string;
  model?: string;
  mediaUrl?: string;
  threadId?: string;
}

export class ResetThreadDto {
  reason?: string;
}
