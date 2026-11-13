#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
    (void)previous;
    (void)command;
    (void)show;
    HWND window = CreateWindowExW(0, L"STATIC", L"HelloTray", 0,
                                   0, 0, 0, 0, NULL, NULL, instance, NULL);
    if (!window) return 1;
    NOTIFYICONDATAW icon = {0};
    icon.cbSize = sizeof(icon);
    icon.hWnd = window;
    icon.uID = 1;
    icon.uFlags = NIF_ICON | NIF_TIP;
    icon.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    lstrcpyW(icon.szTip, L"Hello tray");
    if (!Shell_NotifyIconW(NIM_ADD, &icon)) return 2;
    Sleep(2000);
    Shell_NotifyIconW(NIM_DELETE, &icon);
    DestroyWindow(window);
    return 0;
}
#endif
