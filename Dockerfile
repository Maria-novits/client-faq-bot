FROM mcr.microsoft.com/powershell:7.4-ubuntu-22.04
WORKDIR /app
COPY bot.ps1 faq.json ./
ENV BOT_DATA_DIR=/data
CMD ["pwsh", "-NoLogo", "-NoProfile", "-File", "/app/bot.ps1"]
