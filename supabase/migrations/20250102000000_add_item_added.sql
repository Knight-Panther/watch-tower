-- Add item_added column to track newly inserted items per fetch run
alter table feed_fetch_runs add column item_added integer;
