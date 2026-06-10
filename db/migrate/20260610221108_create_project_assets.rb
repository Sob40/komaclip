class CreateProjectAssets < ActiveRecord::Migration[8.1]
  def change
    create_table :project_assets do |t|
      t.references :project, null: false, foreign_key: true
      t.references :user, null: false, foreign_key: true
      t.string :kind, null: false
      t.string :status, null: false, default: "pending"
      t.string :filename, null: false
      t.string :content_type, null: false
      t.bigint :byte_size, null: false
      t.string :checksum
      t.string :storage_key
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :project_assets, [ :project_id, :kind ]
    add_index :project_assets, [ :project_id, :status ]
    add_index :project_assets, :storage_key, unique: true
  end
end
