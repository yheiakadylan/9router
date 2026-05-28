import { parseBase64DataUrl, getExtensionFromMime } from "../../utils/storage.js";

// Basic TXT2IMG workflow placeholder
const WORKFLOW_TXT2IMG = {
  "3": { "class_type": "KSampler", "inputs": { "seed": 123, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] } },
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
  "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "masterpiece, best quality, beautiful", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "bad hands, lowres", "clip": ["4", 1] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] } }
};

// Basic IMG2IMG workflow placeholder
const WORKFLOW_IMG2IMG = {
  "3": { "class_type": "KSampler", "inputs": { "seed": 123, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.5, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["10", 0] } },
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "masterpiece, best quality", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "bad hands, lowres", "clip": ["4", 1] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] } },
  "10": { "class_type": "VAEEncode", "inputs": { "pixels": ["11", 0], "vae": ["4", 2] } },
  "11": { "class_type": "LoadImage", "inputs": { "image": "default.png" } }
};

export default {
  noAuth: true,
  buildUrl: () => "http://localhost:8188/prompt",
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: async (_model, body) => {
    let promptWorkflow = JSON.parse(JSON.stringify(WORKFLOW_TXT2IMG));
    
    if (body.image) {
      promptWorkflow = JSON.parse(JSON.stringify(WORKFLOW_IMG2IMG));
      
      // Upload image to ComfyUI first
      let filename = "default.png";
      if (body.image.startsWith("data:")) {
        const { buffer, mimeType } = parseBase64DataUrl(body.image);
        const ext = getExtensionFromMime(mimeType);
        
        const formData = new FormData();
        const blob = new Blob([buffer], { type: mimeType });
        formData.append("image", blob, `upload_${Date.now()}.${ext}`);
        
        const uploadRes = await fetch("http://localhost:8188/upload/image", {
          method: "POST",
          body: formData
        });
        
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          filename = uploadData.name;
        }
      }
      
      // Map to workflow
      promptWorkflow["11"].inputs.image = filename;
      if (body.prompt) promptWorkflow["6"].inputs.text = body.prompt;
    } else {
      if (body.prompt) promptWorkflow["6"].inputs.text = body.prompt;
    }
    
    return { prompt: promptWorkflow };
  },
  normalize: (responseBody) => responseBody, // Async polling logic should really be in parseResponse
};
