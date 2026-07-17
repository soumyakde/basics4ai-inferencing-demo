@echo off
cd /d C:\Users\soumy\basics4ai_inferencing_demo
call conda activate b4ai_v0
uvicorn app:app --host 0.0.0.0 --port 8800
