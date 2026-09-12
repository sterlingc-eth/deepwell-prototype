@echo off
REM DeepWell Ask build - removes the files the rebuild deleted, then installs dependencies.
REM Double-click this file, or run it from Command Prompt inside the deepwell-prototype folder.
cd /d "%~dp0"

echo Removing files replaced by the Ask build...
if exist "src\App.css" del /q "src\App.css"
if exist "src\TestMinimal.tsx" del /q "src\TestMinimal.tsx"
if exist "src\assets" rmdir /s /q "src\assets"
if exist "src\components\DataField.tsx" del /q "src\components\DataField.tsx"
if exist "src\components\EquipmentCard.tsx" del /q "src\components\EquipmentCard.tsx"
if exist "src\components\SearchResult.tsx" del /q "src\components\SearchResult.tsx"
if exist "src\components\ServiceHistoryTimeline.tsx" del /q "src\components\ServiceHistoryTimeline.tsx"
if exist "src\screens\DocumentIngestionScreen.tsx" del /q "src\screens\DocumentIngestionScreen.tsx"
if exist "src\screens\EquipmentDetailScreen.tsx" del /q "src\screens\EquipmentDetailScreen.tsx"
if exist "src\screens\ExtractionReviewScreen.tsx" del /q "src\screens\ExtractionReviewScreen.tsx"
if exist "src\screens\HomeScreen.tsx" del /q "src\screens\HomeScreen.tsx"
if exist "src\screens\JobDispatchBriefScreen.tsx" del /q "src\screens\JobDispatchBriefScreen.tsx"
if exist "src\screens\OnSiteSearchScreen.tsx" del /q "src\screens\OnSiteSearchScreen.tsx"
if exist "src\screens\TechnicianProfileScreen.tsx" del /q "src\screens\TechnicianProfileScreen.tsx"
if exist "src\screens\WarrantyTrackingScreen.tsx" del /q "src\screens\WarrantyTrackingScreen.tsx"
if exist "src\services\searchService.ts" del /q "src\services\searchService.ts"
echo Done.
if not exist ".env.local.example" (
  echo CLAUDE_API_KEY=sk-ant-YOUR_API_KEY_HERE> .env.local.example
  echo VITE_ANSWER_PROVIDER=mock>> .env.local.example
)

echo.
echo Installing dependencies (this takes a minute)...
call npm install

echo.
echo Building to make sure everything is clean...
call npm run build

echo.
echo ==========================================================
echo  Finished. Now open GitHub Desktop, write the commit
echo  message "Ask interface build" and click Push origin.
echo  Vercel will deploy from main automatically.
echo ==========================================================
pause
