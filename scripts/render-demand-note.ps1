param(
  [Parameter(Mandatory = $true)][string]$TemplatePath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$DataPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Escape-XmlText([string]$Value) {
  if ($null -eq $Value) { return "" }
  return [System.Security.SecurityElement]::Escape($Value)
}

if (!(Test-Path -LiteralPath $TemplatePath)) {
  throw "Template not found: $TemplatePath"
}
if (!(Test-Path -LiteralPath $DataPath)) {
  throw "Data file not found: $DataPath"
}

$data = Get-Content -LiteralPath $DataPath -Raw | ConvertFrom-Json

$outputDir = Split-Path -Parent $OutputPath
if ($outputDir -and !(Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

Copy-Item -LiteralPath $TemplatePath -Destination $OutputPath -Force

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
  $entry = $zip.GetEntry("word/document.xml")
  if ($null -eq $entry) {
    throw "word/document.xml entry missing in template."
  }

  $reader = New-Object System.IO.StreamReader($entry.Open())
  try {
    $xml = $reader.ReadToEnd()
  }
  finally {
    $reader.Dispose()
  }

  $replacements = [ordered]@{
    "[Name of the Organization]" = Escape-XmlText([string]$data.organisationName)
    "[Name of Organization]" = Escape-XmlText([string]$data.organisationName)
    "[Department / Office Name]" = Escape-XmlText([string]$data.departmentName)
    "[Address Line 1]" = Escape-XmlText([string]$data.addressLine1)
    "[City - PIN Code]" = Escape-XmlText([string]$data.cityPin)
    "[purpose/description of use]" = Escape-XmlText([string]$data.purposeDescription)
    "Rs. ________________/-" = "Rs. $(Escape-XmlText([string]$data.amount))/-"
    "Rupees _____________________________________________ Only" = "Rupees $(Escape-XmlText([string]$data.amount)) Only"
  }

  foreach ($pair in $replacements.GetEnumerator()) {
    $xml = $xml.Replace($pair.Key, $pair.Value)
  }

  if ([string]::IsNullOrWhiteSpace([string]$data.areaValue) -eq $false) {
    $area = Escape-XmlText([string]$data.areaValue)
    $xml = [regex]::Replace($xml, ">______</w:t><w:r><w:t xml:space=""preserve"">Ac\.", ">$area</w:t><w:r><w:t xml:space=""preserve"">Ac.", 1)
  }
  if ([string]::IsNullOrWhiteSpace([string]$data.fromDate) -eq $false) {
    $fromDate = Escape-XmlText([string]$data.fromDate)
    $xml = [regex]::Replace($xml, ">__________</w:t><w:r><w:t xml:space=""preserve""> to ", ">$fromDate</w:t><w:r><w:t xml:space=""preserve""> to ", 1)
  }
  if ([string]::IsNullOrWhiteSpace([string]$data.toDate) -eq $false) {
    $toDate = Escape-XmlText([string]$data.toDate)
    $xml = [regex]::Replace($xml, ">__________</w:t><w:r><w:t xml:space=""preserve""> treating it as a fresh lease", ">$toDate</w:t><w:r><w:t xml:space=""preserve""> treating it as a fresh lease", 1)
  }
  if ([string]::IsNullOrWhiteSpace([string]$data.dueDate) -eq $false) {
    $dueDate = Escape-XmlText([string]$data.dueDate)
    $xml = [regex]::Replace($xml, ">__________</w:t><w:r><w:t xml:space=""preserve""> is enclosed as ", ">$dueDate</w:t><w:r><w:t xml:space=""preserve""> is enclosed as ", 1)
  }

  $entry.Delete()
  $newEntry = $zip.CreateEntry("word/document.xml")
  $writer = New-Object System.IO.StreamWriter($newEntry.Open(), [System.Text.UTF8Encoding]::new($false))
  try {
    $writer.Write($xml)
  }
  finally {
    $writer.Dispose()
  }
}
finally {
  $zip.Dispose()
}
