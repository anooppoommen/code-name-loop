import { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import { useComposerDraftStore } from '../../stores/composerDraftStore';

const EMPTY_IMAGES: ReturnType<typeof useComposerDraftStore.getState>['composerImagesMap'][string] = [];

interface ComposerImageStripProps {
  conversationId: string;
}

export const ComposerImageStrip = memo(function ComposerImageStrip({
  conversationId,
}: ComposerImageStripProps) {
  const composerImages = useComposerDraftStore((state) => state.composerImagesMap[conversationId] ?? EMPTY_IMAGES);
  const setComposerImages = useComposerDraftStore((state) => state.setComposerImages);

  const removeImage = useCallback((imageId: string) => {
    setComposerImages(conversationId, (previous) => previous.filter((image) => image.id !== imageId));
  }, [conversationId, setComposerImages]);

  if (composerImages.length === 0) {
    return null;
  }

  return (
    <div className="relative z-10 mb-2 flex flex-wrap gap-2 px-1">
      {composerImages.map((img) => (
        <div
          key={img.id}
          className="group relative h-16 w-16 overflow-hidden rounded-md border border-loop-700 bg-loop-900"
        >
          <img src={img.dataUrl} alt="attachment" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => removeImage(img.id)}
            className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
});
