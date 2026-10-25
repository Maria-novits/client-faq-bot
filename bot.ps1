param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$faq = Get-Content -LiteralPath "$PSScriptRoot/faq.json" -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-Answer([string]$Text) {
    $t = $Text.ToLowerInvariant().Replace('ё','е')
    if ($t -match 'цен|стоим|прайс|сколько|наращив|коррекц|сняти|дизайн') { return $faq.prices }
    if ($t -match 'адрес|находит|находят|где|добраться') { return $faq.address }
    if ($t -match 'дат|окош|окна|время|свобод|когда|запис') { return $faq.dates }
    return $faq.fallback
}
if ($SelfTest) {
    foreach ($case in @(@('Свободная дата для записи?', $faq.dates), @('сколько стоит?', $faq.prices), @('Есть прайс?', $faq.prices), @('свободные окошки?', $faq.dates), @('когда можно записаться?', $faq.dates), @('Где вы находитесь?', $faq.address), @('Привет!', $faq.fallback))) {
        if ((Get-Answer $case[0]) -ne $case[1]) { throw "Ошибка проверки: $($case[0])" }
    }
    Write-Host 'Проверка пройдена: 7 вопросов, все ответы верные.'
    exit
}
$dataDir = if ($env:BOT_DATA_DIR) { $env:BOT_DATA_DIR } else { $PSScriptRoot }
if (-not (Test-Path -LiteralPath $dataDir)) { $null = New-Item -ItemType Directory -Path $dataDir -Force }
$configPath = Join-Path $dataDir 'settings.json'
$statePath = Join-Path $dataDir 'state.json'
function Save-Config {
    $stored = if ($env:BOT_TOKEN) { [pscustomobject]@{ owner=$script:config.owner } } else { $script:config }
    $stored | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}
if ($env:BOT_TOKEN) {
    if (-not $env:BOT_SETUP_CODE -or $env:BOT_SETUP_CODE.Length -lt 16) { throw 'Задайте секретный BOT_SETUP_CODE длиной не менее 16 символов в настройках облака.' }
    $owner = ''
    if (Test-Path -LiteralPath $configPath) { $owner = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).owner }
    $config = [pscustomobject]@{ token=$env:BOT_TOKEN.Trim(); owner=$owner; pairing=$env:BOT_SETUP_CODE }
} elseif (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    Write-Host 'Вставьте токен из BotFather. Ввод скрыт, это нормально.'
    $secret = Read-Host -AsSecureString 'Токен'
    $token = [Net.NetworkCredential]::new('', $secret).Password.Trim()
    if ($token -notmatch '^\d+:[A-Za-z0-9_-]+$') { throw 'Токен имеет неверный формат. Запустите снова.' }
    $config = [pscustomobject]@{ token = $token; owner = ''; pairing = [guid]::NewGuid().ToString('N').Substring(0,12) }
    Save-Config
}
function Api([string]$Method, $Body) {
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    $r = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($config.token)/$Method" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 45
    if (-not $r.ok) { throw 'Telegram отклонил запрос.' }
    return $r.result
}
$menu = @{ keyboard = @(@(@{text='Запись'}, @{text='Прайс'}, @{text='Адрес'})); resize_keyboard = $true }
function Send($Id, [string]$Text) { $null = Api 'sendMessage' @{chat_id=$Id; text=$Text; reply_markup=$menu} }
$state = @{ offset = 0; sessions = @{} }
if (Test-Path -LiteralPath $statePath) {
    $saved = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $state.offset = $saved.offset
    foreach ($p in $saved.sessions.PSObject.Properties) {
        $state.sessions[$p.Name] = @{step=$p.Value.step; name=$p.Value.name; phone=$p.Value.phone}
    }
}
function Save-State { $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8 }
try { $me = Api 'getMe' @{} } catch { throw 'Не удалось подключиться. Проверьте интернет и токен в settings.json. Подробности скрыты, чтобы не показать токен.' }
Write-Host "Бот: https://t.me/$($me.username)"
if (-not $config.owner -and -not $env:BOT_TOKEN) {
    Write-Host "Откройте бота в своём Telegram и отправьте: /owner $($config.pairing)"
}
Write-Host 'Бот запущен. Для работы должна быть запущена ровно одна копия.'
while ($true) {
    try {
        $updates = Api 'getUpdates' @{offset=$state.offset; timeout=25; allowed_updates=@('message')}
        foreach ($u in $updates) {
            $m = $u.message
            if ($m -and $m.chat.type -eq 'private') {
                $id = [string]$m.chat.id
                $text = [string]$m.text
                if (-not $config.owner -and $text -ceq "/owner $($config.pairing)") {
                    $config.owner = $id
                    $config.pairing = ''
                    Save-Config
                    Send $id 'Готово! Контакты клиентов будут приходить сюда. Теперь проверьте кнопки или напишите свой вопрос.'
                } elseif (-not $config.owner) {
                    Send $id 'Бот пока настраивается. Пожалуйста, зайдите позже.'
                } elseif ($text -eq '/cancel' -or $text -eq '/start') {
                    $state.sessions.Remove($id)
                    Send $id 'Здравствуйте! Я помогу узнать свободные даты, цены и адрес. Выберите кнопку или напишите вопрос. Чтобы оставить заявку, отправьте /contact. Отменить ввод можно командой /cancel.'
                } elseif ($text -eq 'Оставить контакты' -or $text -eq '/contact') {
                    $state.sessions[$id] = @{step='name'; name=''; phone=''}
                    Send $id 'Отправляя контакты, вы передаёте их мастеру для связи по заявке. Как вас зовут? Для отмены: /cancel.'
                } elseif ($state.sessions.ContainsKey($id)) {
                    $s = $state.sessions[$id]
                    switch ($s.step) {
                        'name' {
                            if ($text.Trim().Length -lt 2 -or $text.Length -gt 100) { Send $id 'Напишите имя текстом, от 2 до 100 символов.' }
                            else { $s.name=$text.Trim(); $s.step='phone'; Send $id 'Напишите номер телефона с кодом страны, например +7 999 123-45-67.' }
                        }
                        'phone' {
                            $phone = if ($m.contact) { [string]$m.contact.phone_number } else { $text }
                            if ($phone -notmatch '^\+?[\d\s()\-]{10,25}$' -or ($phone -replace '\D','').Length -lt 10 -or ($phone -replace '\D','').Length -gt 15) { Send $id 'Не удалось распознать номер. Напишите его с кодом страны.' }
                            else { $s.phone=$phone; $s.step='method'; Send $id 'Как удобнее связаться: звонок, сообщение в WhatsApp или сообщение в Telegram?' }
                        }
                        'method' {
                            if ($text -notmatch '(?i)звон|сообщ|whats|ватс|вацап|телег|telegram' -or $text.Length -gt 200) { Send $id 'Укажите способ связи: звонок, WhatsApp или Telegram.' }
                            else {
                                $who = if ($m.from.username) { "@$($m.from.username)" } else { "ID: $id" }
                                Send $config.owner "Новая заявка!`nИмя: $($s.name)`nТелефон: $($s.phone)`nСпособ связи: $text`nTelegram: $who"
                                $state.sessions.Remove($id)
                                Save-State
                                Send $id 'Спасибо! Ваши контакты переданы мастеру. Мы скоро свяжемся с вами. Дата и время записи согласовываются отдельно.'
                            }
                        }
                    }
                } else { Send $id (Get-Answer $text) }
            }
            $state.offset = [long]$u.update_id + 1
            Save-State
        }
    } catch {
        Write-Host 'Не удалось обработать запрос. Повторю через 5 секунд. Если ошибка повторяется, проверьте интернет и не запускайте вторую копию бота.'
        Start-Sleep -Seconds 5
    }
}
