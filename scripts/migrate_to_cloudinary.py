import os
import json
import time
import cloudinary
import cloudinary.uploader
import cloudinary.api
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

cloudinary.config(
    cloud_name=os.getenv('CLOUDINARY_CLOUD_NAME'),
    api_key=os.getenv('CLOUDINARY_API_KEY'),
    api_secret=os.getenv('CLOUDINARY_API_SECRET')
)

DATA_FILE = 'app/frontend/public/data/sign_videos.json'
OUTPUT_FILE = 'app/frontend/public/data/sign_videos.json' # overwrite the same file, but we will create a backup first

def migrate_videos(limit=2000):
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    glosses_dict = data.get('glosses', {})
    
    # Backup original data just in case
    backup_file = f"{DATA_FILE}.backup_cloudinary"
    if not os.path.exists(backup_file):
        with open(backup_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            
    print(f"Total glosses: {len(glosses_dict)}. Migrating up to {limit} glosses...")
    
    migrated_count = 0
    
    try:
        for idx, (gloss_key, gloss_info) in enumerate(glosses_dict.items()):
            if migrated_count >= limit:
                break
                
            videos = gloss_info.get('videos', [])
            if not videos:
                continue
                
            # Check if we already migrated this word
            # If the only video in the list is from cloudinary, we can skip
            if len(videos) == 1 and videos[0].get('source') == 'cloudinary':
                migrated_count += 1
                continue
            elif any(v.get('source') == 'cloudinary' for v in videos):
                # If there's at least one cloudinary, filter out the rest
                cloud_video = next(v for v in videos if v.get('source') == 'cloudinary')
                gloss_info['videos'] = [cloud_video]
                gloss_info['video_count'] = 1
                migrated_count += 1
                continue
            
            # Find the best video to upload (prefer mp4)
            best_video = None
            for v in videos:
                if v.get('type') == 'mp4':
                    best_video = v
                    break
                    
            # Fallback to the first video if no mp4 found (could be youtube, which might fail direct upload but we try anyway)
            if not best_video and videos:
                best_video = videos[0]
                
            if not best_video:
                continue
                
            video_url = best_video.get('url')
            
            print(f"[{idx+1}/{len(glosses_dict)}] Uploading {gloss_key} (from {best_video.get('source')})...")
            try:
                # Upload to cloudinary
                public_id = f"signlangue_videos/{gloss_key}"
                upload_result = cloudinary.uploader.upload(
                    video_url, 
                    resource_type="video", 
                    public_id=public_id,
                    overwrite=True
                )
                
                # Update JSON
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
                
            except Exception as e:
                print(f"  -> Failed to upload {gloss_key}: {e}")
                # We don't increment migrated_count so it might try again or we just leave it for now
                continue
                
            # Save checkpoint every 10 glosses to avoid losing progress
            if migrated_count % 10 == 0:
                with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"--- Saved checkpoint at {migrated_count} migrated glosses ---")
                
            time.sleep(1) # Small delay to respect rate limits
            
    except KeyboardInterrupt:
        print("\nInterrupted by user. Saving current progress...")
    
    # Final save
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Migration finished. Total successfully migrated: {migrated_count}")

if __name__ == "__main__":
    import sys
    limit = 2000
    if len(sys.argv) > 1:
        limit = int(sys.argv[1])
    migrate_videos(limit)
