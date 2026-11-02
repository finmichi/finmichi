# 合成市場回應

依 ADR-0012 rev1.3 的正式欄位契約人工合成；不含真實交易、帳戶或錄下的真實行情。bot.csv含UTF-8 BOM、CRLF及21欄；JSON額外欄位可存在。oracle.json由Python Decimal（precision100、HALF_UP）獨立計算，CI只讀預期值，沒有Python執行相依；DB另以PostgreSQL numeric獨立對照。
