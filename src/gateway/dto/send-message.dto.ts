export class SendMessageDto {
  content: string;
  channelId?: string;
  model?: string;
  mediaUrl?: string;
  /** Đường dẫn tuyệt đối trên server (chỉ dùng khi client tin cậy / đã upload file) */
  mediaPath?: string;
  threadId?: string;
}

export class ResetThreadDto {
  reason?: string;
}
