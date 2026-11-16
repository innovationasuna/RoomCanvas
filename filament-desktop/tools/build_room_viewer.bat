@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
set CMAKE=C:\Users\lenovo\AppData\Roaming\Python\Python312\Scripts\cmake.exe
if not exist "D:\FilamentDesktop\scene\out" mkdir "D:\FilamentDesktop\scene\out"
"%CMAKE%" -S "D:\FilamentDesktop\scene" -B "D:\FilamentDesktop\scene\out" -G Ninja -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 exit /b 1
"%CMAKE%" --build "D:\FilamentDesktop\scene\out" --config Release
