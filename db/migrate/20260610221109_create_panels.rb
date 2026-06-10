class CreatePanels < ActiveRecord::Migration[8.1]
  def change
    create_table :panels do |t|
      t.references :project, null: false, foreign_key: true
      t.references :project_asset, null: false, foreign_key: true
      t.integer :position, null: false
      t.string :label
      t.jsonb :crop, null: false, default: {}
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :panels, [ :project_id, :position ], unique: true
  end
end
