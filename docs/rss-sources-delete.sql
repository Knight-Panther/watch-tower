-- Preserve feed_items when deleting sources

alter table feed_items
  drop constraint if exists feed_items_source_id_fkey;

alter table feed_items
  add constraint feed_items_source_id_fkey
  foreign key (source_id)
  references rss_sources(id)
  on delete set null;
