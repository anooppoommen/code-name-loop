import type { ToolReplyActions } from '../tool-cards';

export type ActivityToolReplyProps = Pick<
  ToolReplyActions,
  'canCompose' | 'isSending' | 'onUseToolReply' | 'onSendToolReply'
>;

export type ActivityImageSelectHandler = (imageUrl: string) => void;

export type ActivityEditMessageHandler = (
  messageId: string,
  text: string,
  images: { mimeType: string; dataUrl: string }[],
) => void;
