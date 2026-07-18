import os
import json
import time
import cloudinary
import cloudinary.uploader
import cloudinary.api
from dotenv import load_dotenv
import yt_dlp

# Load environment variables
load_dotenv()

cloudinary.config(
    cloud_name=os.getenv('CLOUDINARY_CLOUD_NAME'),
    api_key=os.getenv('CLOUDINARY_API_KEY'),
    api_secret=os.getenv('CLOUDINARY_API_SECRET')
)

DATA_FILE = 'app/frontend/public/data/sign_videos.json'

def migrate_youtube_videos(limit=2000):
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    glosses_dict = data.get('glosses', {})
    
    migrated_count = 0
    failed_count = 0
    
    ydl_opts = {
        'format': 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
        'outtmpl': 'temp_video.%(ext)s',
        'quiet': True,
        'no_warnings': True
    }
    
    for idx, (gloss_key, gloss_info) in enumerate(glosses_dict.items()):
        if idx >= limit:
            break
            
        videos = gloss_info.get('videos', [])
        if not videos:
            continue
            
        if videos[0].get('source') == 'cloudinary':
            continue
            
        # Needs migration
        video_url = videos[0].get('url')
        print(f"[{idx+1}/{limit}] Downloading YouTube video for '{gloss_key}'...")
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                ext = info.get('ext', 'mp4')
                filename = f"temp_video.{ext}"
                
            if not os.path.exists(filename):
                raise Exception("Download failed, file not found.")
                
            print(f"  -> Downloaded. Uploading to Cloudinary...")
            public_id = f"signlangue_videos/{gloss_key}"
            
            upload_result = cloudinary.uploader.upload(
                filename, 
                resource_type="video", 
                public_id=public_id,
                overwrite=True
            )
            
            new_video = {
                "url": upload_result['secure_url'],
                "source": "cloudinary",
                "type": "mp4",
                "video_id": public_id
            }
            
            gloss_info['videos'] = [new_video]
            gloss_info['video_count'] = 1
            migrated_count += 1
            print(f"  -> Success: {new_video['url']}")
            
            # Clean up temp file
            if os.path.exists(filename):
                os.remove(filename)
                
            # Checkpoint save
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                
        except Exception as e:
            print(f"  -> Failed to migrate {gloss_key}: {e}")
            failed_count += 1
            if os.path.exists('temp_video.mp4'):
                os.remove('temp_video.mp4')
            if os.path.exists('temp_video.mkv'):
                os.remove('temp_video.mkv')
            if os.path.exists('temp_video.webm'):
                os.remove('temp_video.webm')
                
        time.sleep(1)
            
    print(f"Migration finished. Successfully migrated: {migrated_count}, Failed: {failed_count}")

if __name__ == "__main__":
    migrate_youtube_videos(2000)
