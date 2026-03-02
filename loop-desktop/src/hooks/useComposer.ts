import { useCallback, useMemo, useState } from 'react';
import type { ComposerImage, QueuedMessage } from './useLoopDesktop.types';

export interface UseComposerReturn {
    composerInputs: Record<string, string>;
    composerImagesMap: Record<string, ComposerImage[]>;
    queuedMessagesMap: Record<string, QueuedMessage[]>;
    editingMessageByConversation: Record<string, string>;
    setEditingMessageByConversation: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    editingMessageId: string;
    messageInput: string;
    setMessageInput: (value: React.SetStateAction<string>) => void;
    composerImages: ComposerImage[];
    setComposerImages: React.Dispatch<React.SetStateAction<ComposerImage[]>>;
    queuedMessages: QueuedMessage[];
    setQueuedMessagesMap: React.Dispatch<React.SetStateAction<Record<string, QueuedMessage[]>>>;
    queueMessage: () => void;
    removeQueuedMessage: (id: string) => void;
    reorderQueuedMessage: (id: string, direction: 'up' | 'down') => void;
    enqueueConversationMessage: (conversationId: string, messageText: string, messageImages: ComposerImage[]) => boolean;
}

export function useComposer(selectedConversationId: string): UseComposerReturn {
    const [composerInputs, setComposerInputs] = useState<Record<string, string>>({});
    const [composerImagesMap, setComposerImagesMap] = useState<Record<string, ComposerImage[]>>({});
    const [editingMessageByConversation, setEditingMessageByConversation] = useState<Record<string, string>>({});
    const [queuedMessagesMap, setQueuedMessagesMap] = useState<Record<string, QueuedMessage[]>>({});

    const editingMessageId = editingMessageByConversation[selectedConversationId] || '';

    const messageInput = composerInputs[selectedConversationId] || '';
    const setMessageInput = useCallback((value: React.SetStateAction<string>) => {
        setComposerInputs(prevMap => {
            const prev = prevMap[selectedConversationId] || '';
            const next = typeof value === 'function' ? (value as (prevState: string) => string)(prev) : value;
            return { ...prevMap, [selectedConversationId]: next };
        });
    }, [selectedConversationId]);

    const composerImages = useMemo(
        () => composerImagesMap[selectedConversationId] || [],
        [composerImagesMap, selectedConversationId]
    );
    const setComposerImages = useCallback((value: React.SetStateAction<ComposerImage[]>) => {
        setComposerImagesMap(prevMap => {
            const prev = prevMap[selectedConversationId] || [];
            const next = typeof value === 'function' ? (value as (prevState: ComposerImage[]) => ComposerImage[])(prev) : value;
            return { ...prevMap, [selectedConversationId]: next };
        });
    }, [selectedConversationId]);

    const queuedMessages = useMemo(
        () => queuedMessagesMap[selectedConversationId] || [],
        [queuedMessagesMap, selectedConversationId]
    );

    const enqueueConversationMessage = useCallback(
        (conversationId: string, messageText: string, messageImages: ComposerImage[]): boolean => {
            const text = messageText.trim();
            if (!conversationId || (!text && messageImages.length === 0)) {
                return false;
            }

            setQueuedMessagesMap((prevMap) => {
                const prev = prevMap[conversationId] || [];
                return {
                    ...prevMap,
                    [conversationId]: [...prev, { id: crypto.randomUUID(), text, images: messageImages }],
                };
            });
            return true;
        },
        [],
    );

    const queueMessage = useCallback(() => {
        const queued = enqueueConversationMessage(selectedConversationId, messageInput, composerImages);
        if (!queued) {
            return;
        }
        setMessageInput('');
        setComposerImages([]);
    }, [composerImages, enqueueConversationMessage, messageInput, selectedConversationId, setComposerImages, setMessageInput]);

    const removeQueuedMessage = useCallback((id: string) => {
        setQueuedMessagesMap(prevMap => {
            const prev = prevMap[selectedConversationId] || [];
            return { ...prevMap, [selectedConversationId]: prev.filter(m => m.id !== id) };
        });
    }, [selectedConversationId]);

    const reorderQueuedMessage = useCallback((id: string, direction: 'up' | 'down') => {
        setQueuedMessagesMap(prevMap => {
            const prev = prevMap[selectedConversationId] || [];
            const idx = prev.findIndex(m => m.id === id);
            if (idx < 0) return prevMap;

            const next = [...prev];
            if (direction === 'up' && idx > 0) {
                [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
            } else if (direction === 'down' && idx < prev.length - 1) {
                [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
            }
            return { ...prevMap, [selectedConversationId]: next };
        });
    }, [selectedConversationId]);

    return {
        composerInputs,
        composerImagesMap,
        queuedMessagesMap,
        editingMessageByConversation,
        setEditingMessageByConversation,
        editingMessageId,
        messageInput,
        setMessageInput,
        composerImages,
        setComposerImages,
        queuedMessages,
        setQueuedMessagesMap,
        queueMessage,
        removeQueuedMessage,
        reorderQueuedMessage,
        enqueueConversationMessage,
    };
}
