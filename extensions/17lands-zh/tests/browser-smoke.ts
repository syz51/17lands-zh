// Bundle this entry for browser QA of the production DOM controller, without extension APIs.
import { createImageLoader } from '../src/image-loader';
import { ImageReplacer } from '../src/image-replacer';

const loader = createImageLoader();
const replacer = new ImageReplacer(document, loader.load);
replacer.setEnabled(true);
Object.assign(window, {
  __17landsZhQA: {
    setEnabled: (enabled: boolean) => replacer.setEnabled(enabled),
    retry: () => { loader.clear(); replacer.refresh(); },
    dispose: () => { replacer.dispose(); loader.dispose(); },
  },
});
