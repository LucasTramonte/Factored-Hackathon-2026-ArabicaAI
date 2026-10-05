-- One-off, reviewed data fix (2026-10-05): rename the fictitious demo charges to merchants in the extractor's vocabulary
-- (back-end/src/modules/intake/ai-transport.js), so "I can't find it" suggestions can match them. Same ids, amounts, dates
-- and currency; seeds/seed_fictitious.sql holds the same names, so a later seed reload agrees with remote D1. Only the six
-- fictitious demo customers are touched. A person runs it once (agents never run --remote):
--   cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file scripts/demo-merchant-names.sql
UPDATE transactions SET merchant_name='Mercado Central' WHERE merchant_name='Mercado Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda General' WHERE merchant_name='Loja Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda Don José' WHERE merchant_name='Cafe Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Farmacia Salud' WHERE merchant_name='Farmacia Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Estación de Servicio' WHERE merchant_name='Posto Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Centro Comercial' WHERE merchant_name='Eletronicos Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Restaurante El Buen Sabor' WHERE merchant_name='Restaurante Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Streaming Music' WHERE merchant_name='Streaming Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Conciertos Live' WHERE merchant_name='Viagens Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Super Ahorro' WHERE merchant_name='Padaria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Streaming Music' WHERE merchant_name='Musica Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Ferretería' WHERE merchant_name='Moveis Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Taxi Seguro' WHERE merchant_name='Taxi Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Internet Plus' WHERE merchant_name='Nuvem Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Boutique Moda' WHERE merchant_name='Joalheria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda General' WHERE merchant_name='Livraria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Cable TV' WHERE merchant_name='Jornal Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Centro Comercial' WHERE merchant_name='Eletro Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
